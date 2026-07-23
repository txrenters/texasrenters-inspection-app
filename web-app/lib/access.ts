export function formatPermission(key: string) {
  const [resource, action] = key.split(':');
  if (!action) return key.replaceAll('_', ' ');
  return `${resource.replaceAll('_', ' ')} · ${action.replaceAll('_', ' ')}`;
}
