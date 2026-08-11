// types/externals.d.mts — описания чужих пакетов, которые своих типов не поставляют.
//
// Таких два, и оба — не забытые, а сознательно не типизированные их авторами:
// `draco3dgltf` — обёртка над WASM-сборкой Draco от Google, `gltf-validator` — сборка
// dart2js официального валидатора Khronos. Ставить рядом @types/* неоткуда: их нет.
//
// Описываем РОВНО то, чем пользуемся, и ни строкой больше. Полное описание чужого
// пакета мы поддерживать не сможем, а неполное, но честное — сможем: если однажды
// вызов перестанет совпадать с описанием, компилятор скажет об этом здесь, а не
// оставит `any` и молчание.
//
// Заведено 2026-08-11 при переводе addons/gltf/index на TypeScript.

declare module 'draco3dgltf' {
  /** Модуль-декодер/кодировщик Draco. Внутрь мы не заглядываем — только передаём в NodeIO. */
  type DracoModule = object;
  const draco3d: {
    createDecoderModule: () => Promise<DracoModule>;
    createEncoderModule: () => Promise<DracoModule>;
  };
  export default draco3d;
}

declare module 'gltf-validator' {
  /** Одно сообщение отчёта: код нарушения, важность, указатель на место в JSON. */
  export interface ValidatorMessage {
    code: string;
    /** 0 — ошибка, 1 — предупреждение, дальше — информационные. */
    severity: number;
    message?: string;
    pointer?: string;
  }

  export interface ValidatorReport {
    issues: {
      numErrors: number;
      numWarnings?: number;
      messages: ValidatorMessage[];
    };
  }

  export function validateBytes(bytes: Uint8Array): Promise<ValidatorReport>;
}
