import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  base: './', // 👈 这一行非常重要，确保 GitHub Pages 打包后的静态资源能正确找到路径
  plugins: [vue()],
  server: {
    port: 5232,
  },
});
