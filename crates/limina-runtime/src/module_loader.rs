//! TypeScript-aware module loader for the limina embedder.
//!
//! deno_core only runs JavaScript, so TS/TSX is transpiled here in `load` via
//! `deno_ast` (swc) — transpile-only, no typecheck (like Deno's `--no-check`).
//! Emitted source maps are retained and served through `get_source_map` so V8
//! stack traces point at the original `.ts` lines.

use std::borrow::Cow;
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use deno_ast::{
    EmitOptions, ImportsNotUsedAsValues, MediaType, ParseParams, SourceMapOption,
    TranspileModuleOptions, TranspileOptions,
};
use deno_core::error::ModuleLoaderError;
use deno_core::{
    resolve_import, ModuleLoadOptions, ModuleLoadReferrer, ModuleLoadResponse, ModuleLoader,
    ModuleSource, ModuleSourceCode, ModuleSpecifier, ModuleType, ResolutionKind,
};
use deno_error::JsErrorBox;

type SourceMapStore = Rc<RefCell<HashMap<String, Vec<u8>>>>;

/// Loads `file://` modules, transpiling TS/JSX to JS and caching source maps.
pub struct TypescriptModuleLoader {
    source_maps: SourceMapStore,
}

impl TypescriptModuleLoader {
    pub fn new() -> Self {
        Self {
            source_maps: Rc::new(RefCell::new(HashMap::new())),
        }
    }
}

impl Default for TypescriptModuleLoader {
    fn default() -> Self {
        Self::new()
    }
}

impl ModuleLoader for TypescriptModuleLoader {
    fn resolve(
        &self,
        specifier: &str,
        referrer: &str,
        _kind: ResolutionKind,
    ) -> Result<ModuleSpecifier, ModuleLoaderError> {
        resolve_import(specifier, referrer).map_err(JsErrorBox::from_err)
    }

    fn load(
        &self,
        module_specifier: &ModuleSpecifier,
        _maybe_referrer: Option<&ModuleLoadReferrer>,
        _options: ModuleLoadOptions,
    ) -> ModuleLoadResponse {
        let source_maps = self.source_maps.clone();

        fn load(
            source_maps: SourceMapStore,
            module_specifier: &ModuleSpecifier,
        ) -> Result<ModuleSource, ModuleLoaderError> {
            let path = module_specifier
                .to_file_path()
                .map_err(|_| JsErrorBox::generic("Only file:// URLs are supported."))?;

            let media_type = MediaType::from_path(&path);
            let (module_type, should_transpile) = match media_type {
                MediaType::JavaScript | MediaType::Mjs | MediaType::Cjs => {
                    (ModuleType::JavaScript, false)
                }
                MediaType::Jsx
                | MediaType::TypeScript
                | MediaType::Mts
                | MediaType::Cts
                | MediaType::Dts
                | MediaType::Dmts
                | MediaType::Dcts
                | MediaType::Tsx => (ModuleType::JavaScript, true),
                MediaType::Json => (ModuleType::Json, false),
                _ => {
                    return Err(JsErrorBox::generic(format!(
                        "Unknown extension {:?}",
                        path.extension()
                    )));
                }
            };

            let code = std::fs::read_to_string(&path).map_err(JsErrorBox::from_err)?;
            let code = if should_transpile {
                let parsed = deno_ast::parse_module(ParseParams {
                    specifier: module_specifier.clone(),
                    text: code.into(),
                    media_type,
                    capture_tokens: false,
                    scope_analysis: false,
                    maybe_syntax: None,
                })
                .map_err(JsErrorBox::from_err)?;
                let res = parsed
                    .transpile(
                        &TranspileOptions {
                            imports_not_used_as_values: ImportsNotUsedAsValues::Remove,
                            decorators: deno_ast::DecoratorsTranspileOption::Ecma,
                            ..Default::default()
                        },
                        &TranspileModuleOptions { module_kind: None },
                        &EmitOptions {
                            source_map: SourceMapOption::Separate,
                            inline_sources: true,
                            ..Default::default()
                        },
                    )
                    .map_err(JsErrorBox::from_err)?;
                let res = res.into_source();
                if let Some(source_map) = res.source_map {
                    source_maps
                        .borrow_mut()
                        .insert(module_specifier.to_string(), source_map.into_bytes());
                }
                res.text
            } else {
                code
            };

            Ok(ModuleSource::new(
                module_type,
                ModuleSourceCode::String(code.into()),
                module_specifier,
                None,
            ))
        }

        ModuleLoadResponse::Sync(load(source_maps, module_specifier))
    }

    fn get_source_map(&self, specifier: &str) -> Option<Cow<'_, [u8]>> {
        self.source_maps
            .borrow()
            .get(specifier)
            .map(|v| v.clone().into())
    }
}
