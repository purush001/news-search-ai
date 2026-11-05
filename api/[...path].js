// Vercel serverless entry for every /api/* request. All logic lives in server/.
import { createVercelHandler } from '../server/vercel.js';

export default createVercelHandler();
