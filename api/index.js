// Vercel serverless entry. vercel.json rewrites every /api/* request here, passing the original sub-path
// as ?__path=..., and server/vercel.js restores it. All logic lives in server/.
import { createVercelHandler } from '../server/vercel.js';

export default createVercelHandler();
