// Host APIs newer than the oldest supported Paseo are read from the SDK module at run time, so a
// host without them still loads the plugin and keeps the older behavior.

/** A module export that older hosts may lack; a module object that refuses unknown names counts as lacking it. */
export function optionalExport(module: object, name: string): unknown {
  try {
    return name in module ? Reflect.get(module, name) : undefined;
  } catch {
    return undefined;
  }
}
