import { isPresent } from './helpers/model-files.mjs';

const МОДЕЛИ = ['DiffuseTransmissionTeacup.glb', 'DiffuseTransmissionPlant.glb'];

export async function setup(project) {
  const нет = МОДЕЛИ.filter((m) => !isPresent(m));
  if (нет.length) {
    console.warn(
      '[diffuse-transmission-models.setup] нет локально: ' + нет.join(', ') +
        ' — проверки просвета насквозь пропущены (норма на чистом клоне и на CI)',
    );
  }
  project.provide('diffuse-transmission-models-available', нет.length === 0);
}
