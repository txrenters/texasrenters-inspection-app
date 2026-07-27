export interface Marker {
  x: number;
  y: number;
}

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The rendered image rectangle inside an object-fit:contain stage (base px). */
export interface ContainRect {
  scale: number;
  renderedW: number;
  renderedH: number;
  offsetX: number;
  offsetY: number;
}

export interface ViewTransform {
  zoom: number;
  pan: { x: number; y: number };
}
