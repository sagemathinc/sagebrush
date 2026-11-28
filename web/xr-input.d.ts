// The types of web/xr-input.js, for the TypeScript that imports it (the 3D view's headset, web/space/src/xr.ts): the
// page's type check has no WebXR types, so the module's own JavaScript isn't checked through that import.

/** Whether this browser can enter `mode` ("immersive-vr" or "immersive-ar"). */
export function supported(mode?: string): Promise<boolean>;

/** An immersive session drawing with `gl` (see xr-input.js). */
export function startSession(gl: WebGL2RenderingContext | WebGLRenderingContext, mode?: string): Promise<{ session: any; refSpace: any; layer: any; floor: boolean; ended: () => boolean }>;

type Hand = { connected: boolean; axes: [number, number]; held: Record<string, boolean>; pressed: Record<string, boolean>; grip: Float32Array | null };
/** The controllers, read once a frame (see xr-input.js). */
export function createInput(): { poll(frame: any, refSpace: any): { left: Hand; right: Hand } };
