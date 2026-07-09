function finiteVector(value) {
  return Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);
}

export function parseTransformDraft(position, rotationDeg, scale) {
  if (!finiteVector(position) || !finiteVector(rotationDeg) || !finiteVector(scale)) {
    return { valid: false };
  }
  return {
    valid: true,
    transform: {
      position: [...position],
      rotationDeg: [...rotationDeg],
      scale: [...scale],
    },
  };
}
