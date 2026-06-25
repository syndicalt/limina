// limina UI substrate (Phase 5-A / A1): an embedded bitmap font + layout +
// styled-box compositor + DataTexture quad. A2 (world containers / bubbles) and
// A4 (ui.* / text.* skills + Zod schema) build on these exports.

export {
  FONT_FIRST_CODE,
  FONT_LAST_CODE,
  type Glyph,
  GLYPH_ADVANCE,
  GLYPH_BASELINE,
  GLYPH_H,
  GLYPH_W,
  glyphFor,
  isPrintable,
} from "./font.ts";

export {
  layout,
  type LayoutOptions,
  type LayoutResult,
  type LineBox,
  measureChars,
  measureLine,
  wrapText,
} from "./layout.ts";

export {
  type Align,
  type BackgroundStyle,
  type BorderStyle,
  type CalloutStyle,
  composite,
  type ColorInput,
  type Composited,
  type GradientDirection,
  type GradientStyle,
  type Insets,
  type PuffStyle,
  type RGBA,
  type ShadowStyle,
  type Side,
  type TailStyle,
  type TextRun,
  type TextRunStyle,
  type TextStyle,
  type TitleStyle,
  toRGBA,
} from "./compositor.ts";

export { Panel, type PanelMesh, type PanelOptions } from "./surface.ts";

export {
  callout,
  type CalloutOptions,
  hudPanel,
  type HudPanelOptions,
  label,
  type LabelOptions,
  sideToward,
  speechBubble,
  type SpeechBubbleOptions,
  textBox,
  type TextBoxOptions,
  thoughtBubble,
  type ThoughtBubbleOptions,
  type Toward,
} from "./containers.ts";

export {
  type AnchorCamera,
  ScreenAnchor,
  type ScreenAnchorOptions,
  type ScreenCorner,
  type Vec3,
  WorldAnchor,
  type WorldAnchorOptions,
} from "./anchor.ts";

export {
  Fade,
  FeedModel,
  Lifetime,
  type QueueMode,
  SpeechQueue,
  type SpeechLine,
  Typewriter,
} from "./lifecycle.ts";

export {
  type UiAnchorSpec,
  type UiCreateOptions,
  type UiHandleResult,
  type UiKind,
  type UiLeaderSpec,
  type UiLifecycleSpec,
  type UiManagerOptions,
  type UiScreenAnchorSpec,
  type UiTailSpec,
  type UiUpdate,
  type UiWorldAnchorSpec,
  UiManager,
} from "./manager.ts";
