const config = {
  title: 'OpenRA in the Browser',
  tagline: 'The real OpenRA engine, running in WebAssembly',
  url: process.env.DOCUSAURUS_URL ?? 'http://localhost',
  baseUrl: '/',
  onBrokenLinks: 'throw',
  onBrokenMarkdownLinks: 'warn',
  presets: [
    [
      'classic',
      {
        docs: {
          routeBasePath: '/',
          sidebarPath: './sidebars.js'
        },
        blog: false,
        theme: {}
      }
    ]
  ],
  themeConfig: {
    colorMode: {
      respectPrefersColorScheme: true
    },
    navbar: {
      title: 'OpenRA Browser',
      items: [
        {
          type: 'docSidebar',
          sidebarId: 'guideSidebar',
          position: 'left',
          label: 'Guide'
        },
        {
          href: 'https://github.com/OpenRA/OpenRA',
          label: 'OpenRA upstream',
          position: 'right'
        }
      ]
    },
    footer: {
      style: 'dark',
      copyright: 'OpenRA is free software under the GNU General Public License.'
    }
  }
};

export default config;
