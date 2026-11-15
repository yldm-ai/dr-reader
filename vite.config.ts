import { createLogger, defineConfig } from 'vite';
import type { Logger } from 'vite';

// MSBuild decodes custom-build output with the OEM code page, so Vite's UTF-8 "✓" shows up as
// "Γ£ô" in Visual Studio builds. CMake sets DR_ASCII_LOG for that build; swap the glyph there.
function asciiLogger(): Logger {
  const logger = createLogger();
  const info = logger.info.bind(logger);
  logger.info = (message, options) => info(message.replaceAll('✓', 'OK'), options);
  return logger;
}

export default defineConfig({
  root: 'web',
  base: './',
  customLogger: process.env.DR_ASCII_LOG ? asciiLogger() : undefined,
  build: {
    // Keep the original SVG as a shared file for the sidebar, About page and favicon.
    assetsInlineLimit: (file) => /[/\\]dr-reader\.svg$/.test(file) ? false : undefined,
    outDir: '../dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
  },
});
