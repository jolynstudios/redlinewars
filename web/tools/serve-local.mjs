// Serves the composed production build on port 8470. Keep running while testing.
import { startPrivateComposed } from './private-composed-preview.mjs'
const preview = await startPrivateComposed(8470)
console.log('serving', preview.baseUrl)
setInterval(() => {}, 60000)
