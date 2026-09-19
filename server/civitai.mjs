/* Civitai uses the shared provider and optional Node downloader. */
import { WaveSpeedService } from './wavespeed.mjs';
import { withCivitai } from '../shared/civitai.js';
export { workflowBody, normalizeWorkflow } from '../shared/civitai.js';
export const CivitaiService = withCivitai(WaveSpeedService);
