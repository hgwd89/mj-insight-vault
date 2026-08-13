/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverActions: { bodySizeLimit: '25mb' }
  },
  images: { remotePatterns: [] }
};
export default nextConfig;
