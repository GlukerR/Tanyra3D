// desktop/url-policy.cjs — свой адрес или чужой, и что вообще можно открывать наружу.
//
// Отдельным файлом, потому что main.cjs требует electron и в обычном node не грузится,
// а решение «своё/чужое» обязано проверяться прямо, а не пересказом по исходнику.
//
// Ревью 2026-08-10 (P1.6): проверка шла через `url.startsWith(address)`. Начало строки
// про происхождение не говорит ничего: `http://127.0.0.1:3210.evil.com/` и
// `http://127.0.0.1:32100/` начинаются с разрешённого адреса, а origin у обоих чужой.
// Отдельно `shell.openExternal` получал адрес любой схемы, а система знает не только
// http — там и `file:`, и схемы, через которые запускаются программы.

/** Тот же origin, что у страницы приложения? */
function isOwnPage(url, address) {
  try {
    return new URL(url).origin === new URL(address).origin;
  } catch {
    return false;
  }
}

/** Можно отдать системному браузеру? Список разрешённого, а не запрещённого. */
function isExternalWeb(url) {
  try {
    const p = new URL(url).protocol;
    return p === 'https:' || p === 'http:';
  } catch {
    return false;
  }
}

module.exports = { isOwnPage, isExternalWeb };
