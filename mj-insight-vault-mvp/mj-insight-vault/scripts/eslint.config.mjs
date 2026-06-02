import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { FlatCompat } from '@eslint/eslintrc';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const compat = new FlatCompat({
  baseDirectory: appRoot
});

const config = [
  {
    ignores: [
      '.next/**',
      'node_modules/**',
      'next-env.d.ts',
      'tsconfig.tsbuildinfo'
    ]
  },
  ...compat.extends('next/core-web-vitals', 'next/typescript')
];

export default config;
