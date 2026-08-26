'use client';

import type { ApiDocument, ApiSchema } from '@texasrenters/shared';

import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

/**
 * How far `$ref` chains and nested objects are followed.
 *
 * OpenAPI schemas can be genuinely cyclic — a property referencing a schema that
 * references it back — and the generated document has no guarantee of being
 * acyclic. A depth cap is the honest fix: a visited-set would silently drop the
 * *second* legitimate use of a shared schema, which reads as a documentation bug
 * rather than as the recursion guard it is.
 */
const MAX_DEPTH = 6;

function refName(ref: string) {
  return ref.split('/').pop() ?? ref;
}

/** Follow a `$ref` to the schema it names, or return the schema unchanged. */
export function resolveSchema(
  schema: ApiSchema | undefined,
  document: ApiDocument | undefined,
  depth = 0,
): ApiSchema | undefined {
  if (!schema || depth > MAX_DEPTH) return schema;
  if (schema.$ref) {
    const target = document?.components?.schemas?.[refName(schema.$ref)];
    return target ? resolveSchema(target, document, depth + 1) : schema;
  }
  // `allOf` is how the Swagger plugin expresses "this, plus a named schema" —
  // most often a single-entry list wrapping one ref. Merging shallowly is enough
  // to render it and avoids showing the reader a composition keyword instead of
  // the fields they asked about.
  if (schema.allOf?.length) {
    const merged: ApiSchema = { ...schema, allOf: undefined, type: 'object', properties: {} };
    for (const part of schema.allOf) {
      const resolved = resolveSchema(part, document, depth + 1);
      Object.assign(merged.properties!, resolved?.properties ?? {});
      merged.required = [...(merged.required ?? []), ...(resolved?.required ?? [])];
    }
    return merged;
  }
  return schema;
}

/** A one-line rendering of a type, for the column that has room for one line. */
export function schemaTypeLabel(
  schema: ApiSchema | undefined,
  document: ApiDocument | undefined,
): string {
  if (!schema) return 'unknown';
  if (schema.$ref) return refName(schema.$ref);
  const resolved = resolveSchema(schema, document);
  if (resolved?.type === 'array')
    return `${schemaTypeLabel(resolved.items, document)}[]`;
  if (resolved?.enum?.length) return resolved.enum.map((value) => String(value)).join(' | ');
  return `${resolved?.type ?? 'object'}${resolved?.format ? ` (${resolved.format})` : ''}`;
}

function constraints(schema: ApiSchema | undefined) {
  if (!schema) return [];
  const parts: string[] = [];
  if (schema.minimum !== undefined) parts.push(`min ${schema.minimum}`);
  if (schema.maximum !== undefined) parts.push(`max ${schema.maximum}`);
  if (schema.minLength !== undefined) parts.push(`${schema.minLength}+ chars`);
  if (schema.maxLength !== undefined) parts.push(`≤ ${schema.maxLength} chars`);
  if (schema.default !== undefined) parts.push(`default ${JSON.stringify(schema.default)}`);
  return parts;
}

/**
 * A skeleton value matching a schema, to seed the request body editor.
 *
 * Prefilled with types rather than plausible-looking data on purpose. A body
 * that already reads like a real record invites pressing Send to see what
 * happens — and on this page, Send reaches production. An obviously-empty
 * skeleton makes it clear that every field is the operator's to fill in.
 */
export function schemaSkeleton(
  schema: ApiSchema | undefined,
  document: ApiDocument | undefined,
  depth = 0,
): unknown {
  const resolved = resolveSchema(schema, document);
  if (!resolved || depth > MAX_DEPTH) return null;
  if (resolved.enum?.length) return resolved.enum[0];
  switch (resolved.type) {
    case 'array':
      return [schemaSkeleton(resolved.items, document, depth + 1)];
    case 'object':
      return Object.fromEntries(
        Object.entries(resolved.properties ?? {}).map(([name, property]) => [
          name,
          schemaSkeleton(property, document, depth + 1),
        ]),
      );
    case 'string':
      return '';
    case 'number':
    case 'integer':
      return 0;
    case 'boolean':
      return false;
    default:
      return null;
  }
}

/** The fields of an object schema, as a table. */
export function SchemaTable({
  schema,
  document,
}: {
  schema: ApiSchema | undefined;
  document: ApiDocument | undefined;
}) {
  const resolved = resolveSchema(schema, document);
  const properties = Object.entries(resolved?.properties ?? {});
  if (properties.length === 0)
    return (
      <p className="text-muted-foreground text-sm">
        {resolved
          ? `${schemaTypeLabel(resolved, document)} — no named fields are described.`
          : 'No schema is published for this payload.'}
      </p>
    );
  const required = new Set(resolved?.required ?? []);

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Field</TableHead>
          <TableHead>Type</TableHead>
          <TableHead>Notes</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {properties.map(([name, property]) => {
          const resolvedProperty = resolveSchema(property, document);
          const notes = constraints(resolvedProperty);
          return (
            <TableRow key={name}>
              <TableCell className="align-top">
                <span className="font-mono text-xs">{name}</span>
                {required.has(name) ? (
                  <Badge className="ml-1.5 align-middle" variant="secondary">
                    required
                  </Badge>
                ) : null}
              </TableCell>
              <TableCell className="text-muted-foreground align-top font-mono text-xs">
                {schemaTypeLabel(property, document)}
              </TableCell>
              <TableCell className="text-muted-foreground align-top text-xs">
                {resolvedProperty?.description ? (
                  <p className="text-pretty">{resolvedProperty.description}</p>
                ) : null}
                {notes.length ? <p className="tabular-nums">{notes.join(' · ')}</p> : null}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
