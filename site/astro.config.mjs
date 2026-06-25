// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// Prefix root-relative links/images in Markdown with the base path so the docs'
// cross-links (e.g. /getting-started) resolve under a project subpath like /limina.
// No-op when base is '/' (custom-domain / root hosting).
function rehypeBasePath(base) {
	const prefix = base && base !== '/' ? base.replace(/\/$/, '') : '';
	const fix = (u) =>
		prefix && typeof u === 'string' && u.startsWith('/') && !u.startsWith('//') && !u.startsWith(prefix + '/') && u !== prefix
			? prefix + u
			: u;
	const walk = (node) => {
		if (node.type === 'element' && node.properties) {
			if (node.tagName === 'a' && typeof node.properties.href === 'string') node.properties.href = fix(node.properties.href);
			if ((node.tagName === 'img' || node.tagName === 'source') && typeof node.properties.src === 'string')
				node.properties.src = fix(node.properties.src);
		}
		if (node.children) for (const c of node.children) walk(c);
	};
	return () => (tree) => walk(tree);
}

// Hosting: custom domain on Cloudflare → https://www.liminaengine.com (served at root).
// Overridable per build via SITE_URL / BASE_PATH env (the deploy workflow sets them).
// For GitHub project-path hosting instead, set BASE_PATH='/limina'.
const SITE_URL = process.env.SITE_URL || 'https://www.liminaengine.com';
// Normalize to a leading+trailing slash ('/limina/') so `${import.meta.env.BASE_URL}x`
// joins cleanly; '' or '/' → '/' (root, for a custom domain).
const RAW_BASE = process.env.BASE_PATH ?? '';
const BASE_PATH = !RAW_BASE || RAW_BASE === '/' ? '/' : '/' + RAW_BASE.replace(/^\/+|\/+$/g, '') + '/';

export default defineConfig({
	site: SITE_URL,
	base: BASE_PATH,
	markdown: { rehypePlugins: [rehypeBasePath(BASE_PATH)] },
	integrations: [
		starlight({
			title: 'Limina',
			description:
				'Limina is an agent-native real-time 3D engine. LLM agents are first-class: they build and inhabit the world through a typed, permissioned, traced skill + MCP surface.',
			logo: { src: './src/assets/mark.svg', replacesTitle: false },
			customCss: ['./src/styles/starlight.css'],
			social: [
				{ icon: 'github', label: 'GitHub', href: 'https://github.com/syndicalt/limina' },
			],
			head: [
				{ tag: 'link', attrs: { rel: 'preconnect', href: 'https://fonts.googleapis.com' } },
				{ tag: 'link', attrs: { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: true } },
				{
					tag: 'link',
					attrs: {
						rel: 'stylesheet',
						href: 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap',
					},
				},
				{ tag: 'meta', attrs: { property: 'og:image', content: 'https://www.liminaengine.com/media/og.png?v=2' } },
				{ tag: 'meta', attrs: { property: 'og:image:width', content: '1200' } },
				{ tag: 'meta', attrs: { property: 'og:image:height', content: '630' } },
				{ tag: 'meta', attrs: { name: 'twitter:card', content: 'summary_large_image' } },
				{ tag: 'meta', attrs: { name: 'twitter:image', content: 'https://www.liminaengine.com/media/og.png?v=2' } },
			],
			sidebar: [
				{ label: 'For agents ↗', link: '/agents', attrs: { class: 'sl-agents-link' } },
				{
					label: 'Start',
					items: [
						{ label: 'Introduction', slug: 'introduction' },
						{ label: 'Getting started', slug: 'getting-started' },
						{ label: 'Demos', slug: 'demos' },
					],
				},
				{
					label: 'Concepts',
					items: [
						{ label: 'Architecture & stack', slug: 'architecture' },
						{ label: 'ECS & the world', slug: 'concepts/ecs-and-world' },
						{ label: 'The fixed-timestep loop', slug: 'concepts/loop' },
						{ label: 'Perception', slug: 'concepts/perception' },
						{ label: 'Observability & the world log', slug: 'concepts/observability' },
					],
				},
				{
					label: 'The four pillars',
					items: [
						{ label: 'Skill / Hook Registry', slug: 'pillars/skill-registry' },
						{ label: 'MCP interface', slug: 'pillars/mcp-interface' },
						{ label: 'Observability', slug: 'pillars/observability' },
						{ label: 'Agent ecosystem', slug: 'pillars/agent-ecosystem' },
					],
				},
				{
					label: 'SDK reference',
					items: [{ label: 'Skills reference', slug: 'skills' }],
				},
				{
					label: 'Building agents',
					items: [
						{ label: 'Agent Builders (MCP)', slug: 'building-agents/builders' },
						{ label: 'Agent Players (in-world)', slug: 'building-agents/players' },
						{ label: 'LLM providers', slug: 'building-agents/llm-providers' },
					],
				},
				{
					label: 'Project',
					items: [{ label: 'Roadmap & status', slug: 'roadmap' }],
				},
			],
		}),
	],
});
