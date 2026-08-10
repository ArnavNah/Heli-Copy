import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';

// ANGLE (the Chrome/Edge WebGL driver) logs a benign
// "texImage3D: FLIP_Y or PREMULTIPLY_ALPHA isn't allowed for uploading 3D textures"
// INVALID_OPERATION whenever gl.texImage3D is called while the context's
// UNPACK_FLIP_Y_WEBGL / UNPACK_PREMULTIPLY_ALPHA_WEBGL pixel-store flags are set —
// the WebGL spec forbids them for 3D texture uploads.
//
// three.js triggers this at WebGLState init, where it eagerly creates 1×1 empty
// TEXTURE_3D / TEXTURE_2D_ARRAY fallback textures via gl.texImage3D. In StrictMode
// dev the engine mounts twice on the same canvas/context, so the second WebGLState
// inherits the stale UNPACK_FLIP_Y_WEBGL=true left by the first renderer's texture
// uploads — and ANGLE flags each upload. The message comes from the driver layer
// (it bypasses the page's console.warn, so console filtering can't catch it) and has
// zero visual impact: those empty textures are never sampled.
//
// The correct fix is to normalize the pixel-store flags for the duration of the
// 3D upload, exactly as the WebGL spec requires. Our scene never uploads real 3D
// texture data (no Data3DTexture/DataArrayTexture), so forcing these flags off is
// always safe. Guarded so StrictMode/HMR never double-wraps the prototype.
const glProto = WebGL2RenderingContext.prototype as WebGL2RenderingContext & {
  __heliStrikeTex3DPatched?: boolean;
};
if (!glProto.__heliStrikeTex3DPatched) {
  const origTexImage3D = glProto.texImage3D;
  glProto.texImage3D = function (this: WebGL2RenderingContext, ...args: unknown[]) {
    // Save the current pixel-store state and clear the flags 3D uploads forbid.
    const flipY = this.getParameter(this.UNPACK_FLIP_Y_WEBGL);
    const premult = this.getParameter(this.UNPACK_PREMULTIPLY_ALPHA_WEBGL);
    if (flipY) this.pixelStorei(this.UNPACK_FLIP_Y_WEBGL, false);
    if (premult) this.pixelStorei(this.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    try {
      return origTexImage3D.apply(this, args as Parameters<WebGL2RenderingContext['texImage3D']>);
    } finally {
      // Restore so three.js's per-texture pixel-store bookkeeping is undisturbed.
      if (flipY) this.pixelStorei(this.UNPACK_FLIP_Y_WEBGL, true);
      if (premult) this.pixelStorei(this.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    }
  };
  glProto.__heliStrikeTex3DPatched = true;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
