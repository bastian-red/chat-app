/** @type {import('next').NextConfig} */
const nextConfig = {
  // Docker is the only target: infra/Dockerfile.web copies .next/standalone and
  // runs server.js, which needs the whole traced dependency set in one place.
  output: 'standalone',
  reactStrictMode: true,
  // `@chat/sequencing` as well as `@chat/shared`: the client's socket hook feeds
  // every inbound message through `ReorderBuffer`, so that package is browser
  // code here even though it is a workspace service everywhere else.
  transpilePackages: ['@chat/shared', '@chat/sequencing'],
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
