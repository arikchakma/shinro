export type NavItem = {
  title: string;
  href: string;
};

export type NavSection = {
  title: string;
  items: NavItem[];
};

export const navigation: NavSection[] = [
  {
    title: 'Getting started',
    items: [
      { title: 'Introduction', href: '/' },
      { title: 'Installation', href: '/getting-started' },
      { title: 'Create the app', href: '/create-the-app' },
    ],
  },
  {
    title: 'Core concepts',
    items: [
      { title: 'File routes', href: '/file-routes' },
      { title: 'Directory middleware', href: '/middleware' },
      { title: 'End-to-end types', href: '/type-safety' },
    ],
  },
  {
    title: 'Reference',
    items: [
      { title: 'Configuration', href: '/configuration' },
      { title: 'CLI', href: '/cli' },
      { title: 'File conventions', href: '/file-conventions' },
    ],
  },
];

export const navItems = navigation.flatMap((section) => section.items);

export function normalizePath(pathname: string) {
  if (pathname === '/') {
    return pathname;
  }

  return pathname.replace(/\/$/, '');
}
