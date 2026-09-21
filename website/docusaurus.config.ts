import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { themes as prismThemes } from 'prism-react-renderer';
import type { Config } from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';

const require = createRequire(import.meta.url);
const presetDir = dirname(require.resolve('@docusaurus/preset-classic'));
const themeCommon = require.resolve('@docusaurus/theme-common', { paths: [presetDir] });

const config: Config = {
  title: 'Stim',
  tagline: 'Fast, isolated React Native environments for coding agents',
  favicon: 'img/branding/logo.svg',

  future: {
    v4: true,
  },

  url: 'https://stim.appandflow.com',
  baseUrl: '/',

  organizationName: 'appandflow',
  projectName: 'stim',
  trailingSlash: false,

  onBrokenLinks: 'throw',

  markdown: {
    hooks: {
      onBrokenMarkdownLinks: 'throw',
    },
  },

  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  plugins: [
    function usePresetThemeContext() {
      return {
        name: 'use-preset-theme-context',
        configureWebpack() {
          return { resolve: { alias: { '@docusaurus/theme-common$': themeCommon } } };
        },
      };
    },
  ],

  presets: [
    [
      'classic',
      {
        docs: {
          sidebarPath: './sidebars.ts',
          editUrl: 'https://github.com/appandflow/stim/tree/main/website/',
        },
        blog: false,
        theme: {
          customCss: './src/css/custom.css',
        },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    image: 'img/branding/social-card.png',
    colorMode: {
      defaultMode: 'light',
      respectPrefersColorScheme: false,
    },
    navbar: {
      logo: {
        alt: 'Stim',
        src: 'img/branding/wordmark.svg',
        width: 75,
        height: 36,
      },
      items: [
        {
          type: 'docSidebar',
          sidebarId: 'docs',
          position: 'left',
          label: 'Docs',
        },
        { to: '/benchmarks', label: 'Benchmarks', position: 'left' },
        { to: '/docs/changelog', label: 'Changelog', position: 'left' },
        {
          href: 'https://www.npmjs.com/package/stim',
          label: 'npm',
          position: 'right',
        },
        {
          href: 'https://github.com/appandflow/stim',
          label: 'GitHub',
          position: 'right',
        },
      ],
    },
    footer: {
      style: 'dark',
      links: [
        {
          title: 'Docs',
          items: [
            { label: 'Getting started', to: '/docs/getting-started' },
            { label: 'Commands', to: '/docs/commands' },
            { label: 'Worktrees', to: '/docs/worktrees' },
          ],
        },
        {
          title: 'Packages',
          items: [
            { label: 'stim', href: 'https://www.npmjs.com/package/stim' },
            { label: '@stim-cli/metro', href: 'https://www.npmjs.com/package/@stim-cli/metro' },
            {
              label: '@stim-cli/expo-build-cache',
              href: 'https://www.npmjs.com/package/@stim-cli/expo-build-cache',
            },
          ],
        },
        {
          title: 'More',
          items: [
            { label: 'GitHub', href: 'https://github.com/appandflow/stim' },
            { label: 'Issues', href: 'https://github.com/appandflow/stim/issues' },
          ],
        },
      ],
      copyright: `MIT License. Built by AppAndFlow.`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
      additionalLanguages: ['bash', 'json'],
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
