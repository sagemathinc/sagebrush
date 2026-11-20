// Static assets are served before this runs; anything that isn't one comes here and gets the assets' own answer
// (their 404 page). Nothing else: no API, no bindings but ASSETS.
export default {
  fetch(request: Request, env: { ASSETS: { fetch(request: Request): Promise<Response> } }): Promise<Response> {
    return env.ASSETS.fetch(request);
  },
};
