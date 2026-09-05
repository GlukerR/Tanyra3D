const originalConsoleError = console.error

console.error = (...args) => {
  const message = args.join(' ')
  if (
    message.includes('ResizeObserver loop completed with undelivered notifications')
  ) {
    return
  }
  originalConsoleError.apply(console, args)
}
