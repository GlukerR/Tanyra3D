// tests/browser-setup.mjs — setup для браузерных тестов (@vitest/browser + playwright).
//
// Подавляет безвредные, но шумные предупреждения в stderr, которые возникают из-за
// особенностей работы ResizeObserver в headless-браузере. Сама функциональность
// ResizeObserver (подгонка canvas под размер контейнера) при этом сохраняется —
// фильтруется только сообщение о недопустимом цикле уведомлений, которое является
// внутренним поведением браузера и не влияет на тесты.
//
// Предупреждение: «ResizeObserver loop completed with undelivered notifications.»
// Появляется, когда observer callback не успевает обработать все изменения до
// следующего кадра — штатное поведение в headless-режиме без реального рендеринга.

const originalConsoleError = console.error

console.error = (...args) => {
  const message = args.join(' ')
  if (
    message.includes('ResizeObserver loop completed with undelivered notifications')
  ) {
    return // тихо — безвредное поведение headless-браузера
  }
  originalConsoleError.apply(console, args)
}
