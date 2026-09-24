// Service workflows: a passthrough trigger plus one Code node calling the
// service's handler. The router strips nothing, so drop its private _router key.
import { Workflow, IDS } from './lib.mjs';

function serviceWorkflow(id, name, module, handler) {
  const w = new Workflow(id, name);
  const trig = w.trigger();
  const handle = w.code('Handle', { modules: [module], main: `
const { _router, ...req } = $json;
return { json: ${handler}(req) };
` });
  w.chain(trig, handle);
  return w;
}

export const echo = () => serviceWorkflow(IDS.echo, 'svc-echo', 'services/echo.js', 'echoHandle');
export const template = () => serviceWorkflow(IDS.template, 'svc-template', 'services/template.js', 'templateHandle');
