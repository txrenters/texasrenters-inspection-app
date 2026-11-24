/**
 * One-off: prints the fields and filters Jobber's live schema has for every
 * kind the mirror reads, so the mirror's selections can be checked before any
 * of them is sent (2026-11-24). Introspection only -- reads no records.
 *
 *   node --env-file-if-exists=.env -r ts-node/register/transpile-only scripts/jobber-mirror-probe.ts
 */
import { NestFactory } from '@nestjs/core';

import { AppModule } from '../src/app.module';
import { withTenant } from '../src/database/tenant-context';
import { JobberClient } from '../src/integrations/jobber/jobber.client';

interface TypeRef { name: string | null; kind: string; ofType?: TypeRef | null }
interface Field { name: string; type: TypeRef; args?: { name: string; type: TypeRef }[] }

const TYPE_REF = 'name kind ofType { name kind ofType { name kind ofType { name kind } } }';
const named = (type: TypeRef | null | undefined): string | null => (type ? (type.name ?? named(type.ofType)) : null);

const ROOTS = ['clients', 'properties', 'jobs', 'visits', 'quotes', 'requests'];
const TYPES = ['Client', 'Property', 'Job', 'Visit', 'Quote', 'Request'];

async function main() {
  const organizationId = process.env.JOBBER_LOCAL_ORGANIZATION_ID;
  if (!organizationId) throw new Error('Set JOBBER_LOCAL_ORGANIZATION_ID.');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const client = app.get(JobberClient);
  const ask = <T>(query: string) => withTenant(organizationId, () => client.request<T>(organizationId, query, {}));

  const root = await ask<{ __type: { fields: Field[] } }>(
    `query { __type(name: "Query") { fields { name type { ${TYPE_REF} } args { name type { ${TYPE_REF} } } } } }`,
  );
  const inputs = new Set<string>();
  for (const field of root.__type.fields.filter((f) => ROOTS.includes(f.name))) {
    const filter = field.args?.find((a) => a.name === 'filter');
    console.log(`\nQuery.${field.name}(${field.args?.map((a) => a.name).join(', ')}) filter: ${named(filter?.type)}`);
    if (filter) inputs.add(named(filter.type)!);
  }
  for (const input of inputs) {
    const data = await ask<{ __type: { inputFields: { name: string }[] } }>(
      `query { __type(name: "${input}") { inputFields { name } } }`,
    );
    console.log(`${input}: ${data.__type.inputFields.map((f) => f.name).join(', ')}`);
  }
  for (const type of TYPES) {
    const data = await ask<{ __type: { fields: Field[] } }>(`query { __type(name: "${type}") { fields { name type { ${TYPE_REF} } } } }`);
    console.log(`\n${type}: ${data.__type.fields.map((f) => `${f.name}:${named(f.type)}`).join(' ')}`);
    for (const connection of data.__type.fields.filter((f) => ['notes', 'noteAttachments'].includes(f.name))) {
      const conn = await ask<{ __type: { fields: Field[] } }>(`query { __type(name: "${named(connection.type)}") { fields { name type { ${TYPE_REF} } } } }`);
      const node = named(conn.__type.fields.find((f) => f.name === 'nodes')?.type);
      const shape = await ask<{ __type: { possibleTypes: { name: string }[] | null; fields: { name: string }[] | null } }>(
        `query { __type(name: "${node}") { possibleTypes { name } fields { name } } }`,
      );
      console.log(`  ${type}.${connection.name} -> ${node}: types [${shape.__type.possibleTypes?.map((t) => t.name).join(', ') ?? '-'}] fields [${shape.__type.fields?.map((f) => f.name).join(', ') ?? '-'}]`);
      for (const member of shape.__type.possibleTypes ?? []) {
        const m = await ask<{ __type: { fields: { name: string }[] } }>(`query { __type(name: "${member.name}") { fields { name } } }`);
        console.log(`    ${member.name}: ${m.__type.fields.map((f) => f.name).join(', ')}`);
      }
    }
  }
  // Jobber's calendar also shows tasks ("Key information", "Get Materials"),
  // which are not visits (2026-11-25). Whatever the schema calls them --
  // tasks, events, assessments -- list it with its arguments and fields, so
  // the Schedule can read them once the name is known.
  for (const field of root.__type.fields.filter((f) => /task|event|assessment|calendar/i.test(f.name))) {
    console.log(`\nQuery.${field.name}(${field.args?.map((a) => `${a.name}:${named(a.type)}`).join(', ')}) -> ${named((field as Field).type)}`);
    const conn = await ask<{ __type: { fields: Field[] | null } | null }>(
      `query { __type(name: "${named((field as Field).type)}") { fields { name type { ${TYPE_REF} } } } }`,
    );
    const nodes = conn.__type?.fields?.find((f) => f.name === 'nodes');
    const nodeType = nodes ? named(nodes.type) : named((field as Field).type);
    const shape = await ask<{ __type: { fields: Field[] | null; possibleTypes: { name: string }[] | null } | null }>(
      `query { __type(name: "${nodeType}") { possibleTypes { name } fields { name type { ${TYPE_REF} } } } }`,
    );
    console.log(`  ${nodeType}: ${shape.__type?.fields?.map((f) => `${f.name}:${named(f.type)}`).join(' ') ?? '-'}`);
    if (shape.__type?.possibleTypes?.length) console.log(`  types: ${shape.__type.possibleTypes.map((t) => t.name).join(', ')}`);
  }
  await app.close();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
