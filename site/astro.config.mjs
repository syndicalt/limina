// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// NOTE: update `site` to your real deployment origin before publishing.
// For a GitHub Pages *project* site (syndicalt.github.io/limina) also set `base: '/limina'`.
export default defineConfig({
	site: 'https://limina.dev',
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
