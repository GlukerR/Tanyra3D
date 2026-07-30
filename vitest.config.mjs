// Конфигурация vitest. Появилась 2026-07-29 из-за плавающих падений.
//
// Проблема. Набор интеграционный: тесты гоняют настоящие модели через настоящий
// пайплайн, а правило `textures/ktx2` вдобавок запускает ВНЕШНИЙ процесс `toktx`.
// Время одного теста зависит не от теста, а от того, сколько ещё воркеров vitest
// подняло на соседних ядрах. При дефолтном потолке в 5 секунд это давало красный
// набор на ровном месте: 4 падения из 549 на одном прогоне и 0 на следующем —
// при неизменном коде. Отдельные `}, 30000)` расставлялись по файлам вручную и
// покрывали далеко не всё.
//
// Решение. Общий потолок на весь набор, а не россыпь чисел по файлам. Таймаут
// здесь — страховка от зависания, а не утверждение о скорости: ловить им
// деградацию производительности бессмысленно, цифра всё равно плавает вместе с
// загрузкой машины. От настоящего зависания внешнего инструмента защищает
// CLI_TIMEOUT_MS в addons/gltf/tools.mjs (BUG-007) — он привязан к процессу и
// потому точнее.
//
// Отдельные тесты по-прежнему могут задать свой таймаут третьим аргументом `it`,
// если им нужно БОЛЬШЕ (например прогон 150-мегабайтных моделей из input/).
//
// 2026-07-30: Добавлен browser-проект для viewer-regression.browser.test.mjs.
//   — publicDir внутри browser-проекта (на верхнем уровне не наследуется)
//   — testTimeout/hookTimeout внутри КАЖДОГО проекта (тоже не наследуется)
import { defineConfig } from 'vitest/config'
import { playwright } from '@vitest/browser-playwright'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const threeRoot = path.resolve(__dirname, 'node_modules/three')

// Плагин Vite для раздачи файлов декодеров Three.js по /vendor/three/.
// В production сервер (server.mjs) отдаёт их через express.static, но в тестовом
// окружении dev-сервера Vite этих путей нет. Плагин читает файлы из
// node_modules/three/ и отдаёт с корректным MIME-типом (особенно важно для .wasm).
const threeVendorPlugin = {
  name: 'three-vendor',
  configureServer(viteServer) {
    viteServer.middlewares.use('/vendor/three/', (req, res, next) => {
      // req.url — путь после монтирования middleware, без /vendor/three/.
      // ВНИМАНИЕ: на POSIX path.join сбрасывает первый аргумент, если второй
      // начинается с '/', поэтому УБИРАЕМ ведущий слеш.
      const relPath = (req.url || '').replace(/^\//, '')
      if (!relPath || relPath.includes('..')) return next()
      const filePath = path.join(threeRoot, relPath)
      if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) return next()
      const ext = path.extname(filePath).toLowerCase()
      const mime = {
        '.wasm': 'application/wasm',
        '.js': 'application/javascript',
        '.mjs': 'application/javascript',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.svg': 'image/svg+xml',
        '.drc': 'application/octet-stream',
      }[ext] || 'application/octet-stream'
      res.writeHead(200, { 'Content-Type': mime })
      res.end(fs.readFileSync(filePath))
    })
  },
}

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          include: ['tests/**/*.test.mjs'],
          exclude: ['tests/**/*.browser.test.mjs'],
          // globalSetup выполняется ДО всех тестов — baseline-гейт:
          // падает сразу, если число тестов < 228 или модели пропали с диска.
          // Подробный отчёт — в tests/analyse-baseline.test.mjs.
          globalSetup: ['tests/analyse-baseline.setup.mjs'],
          testTimeout: 120_000,
          hookTimeout: 120_000,
        },
      },
      {
        // publicDir ДОЛЖЕН быть внутри проекта — при использовании projects
        // верхнеуровневые vite-опции не наследуются дочерними проектами.
        publicDir: 'fixtures/models',
        plugins: [threeVendorPlugin],
        test: {
          name: 'browser',
          include: ['tests/**/*.browser.test.mjs'],
          setupFiles: ['tests/browser-setup.mjs'],
          // globalSetup — smoke-гейт: golden-corpus существует и не пуст,
          // fixtures на месте. Мягче node-гейта (нет сравнения с baseline),
          // но предотвращает зелёный бейдж на пустом наборе.
          globalSetup: ['tests/browser-baseline.setup.mjs'],
          testTimeout: 120_000,
          hookTimeout: 120_000,
          browser: {
            enabled: true,
            provider: playwright(),
            headless: true,
            screenshotDirectory: 'tests/__screenshots__',
            screenshotFailures: true,
            instances: [
              { browser: 'chromium' },
            ],
          },
        },
      },
    ],
  },
})
