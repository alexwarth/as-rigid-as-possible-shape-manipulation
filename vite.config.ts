import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset paths, so the built site works when hosted under any
  // subpath (e.g. GitHub Pages) as well as at a domain root.
  base: './',
  build: { target: 'es2022' },
  // Listen on all interfaces so the plaything can be opened on an iPad (or any
  // other device) on the same network, and accept Bonjour/mDNS names such as
  // http://my-mac.local:5173 (Vite otherwise only allows localhost and IPs).
  server: { host: true, port: 5173, allowedHosts: ['.local'] },
  preview: { host: true, port: 4173, allowedHosts: ['.local'] },
});
