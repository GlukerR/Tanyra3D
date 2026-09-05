declare module 'draco3dgltf' {
  type DracoModule = object;
  const draco3d: {
    createDecoderModule: () => Promise<DracoModule>;
    createEncoderModule: () => Promise<DracoModule>;
  };
  export default draco3d;
}

declare module 'gltf-validator' {
  export interface ValidatorMessage {
    code: string;
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
