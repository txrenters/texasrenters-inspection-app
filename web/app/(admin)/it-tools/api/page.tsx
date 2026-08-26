'use client';

import type { ApiDocument, ApiOperation } from '@texasrenters/shared';
import { API_METHODS } from '@texasrenters/shared';
import {
  BotIcon,
  ChevronRightIcon,
  HelpCircleIcon,
  LockIcon,
  SearchIcon,
  UnlockIcon,
} from 'lucide-react';
import { useId, useMemo, useState } from 'react';

import { EndpointConsole } from '@/components/api-reference/endpoint-console';
import { JsonView } from '@/components/api-reference/json-view';
import { SchemaTable, resolveSchema } from '@/components/api-reference/schema-view';
import { PageHeader, SectionHeader } from '@/components/page-header';
import { ErrorState, PageSkeleton } from '@/components/states';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { formatPermission } from '@/lib/access';
import { useOpenApiDocument } from '@/lib/queries';
import { cn } from '@/lib/utils';

interface Endpoint {
  id: string;
  method: string;
  path: string;
  tag: string;
  operation: ApiOperation;
}

/** Colour per verb, so the list is scannable without reading the words. */
const METHOD_TONE: Record<string, string> = {
  get: 'text-info',
  post: 'text-success',
  put: 'text-warning',
  patch: 'text-warning',
  delete: 'text-destructive',
};

function flatten(document: ApiDocument | undefined): Endpoint[] {
  if (!document) return [];
  const endpoints: Endpoint[] = [];
  for (const [path, item] of Object.entries(document.paths))
    for (const method of API_METHODS) {
      const operation = item[method];
      if (!operation) continue;
      endpoints.push({
        id: `${method} ${path}`,
        method,
        path,
        tag: operation.tags?.[0] ?? 'Other',
        operation,
      });
    }
  return endpoints.sort((left, right) => left.path.localeCompare(right.path));
}

function AuthenticationBadges({ operation }: { operation: ApiOperation }) {
  const credentials = operation['x-authentication'];
  const machine = operation['x-machine-accessible'] ?? false;

  // Absent and empty mean opposite things, and conflating them is dangerous.
  // An empty list is a statement — the public report routes are deliberately
  // unauthenticated, the share token being the credential. An absent one means
  // the backend could not read this route's guards, and showing that as "no
  // credential" would report an unreadable route as an unguarded one.
  if (!credentials)
    return (
      <Badge variant="destructive">
        <HelpCircleIcon aria-hidden />
        Authorization unknown
      </Badge>
    );

  return (
    <>
      {credentials.length === 0 ? (
        <Badge variant="secondary">
          <UnlockIcon aria-hidden />
          No credential
        </Badge>
      ) : (
        credentials.map((credential) => (
          <Badge key={credential} variant="secondary">
            <LockIcon aria-hidden />
            {credential === 'BEARER' ? 'Bearer token' : 'API key'}
          </Badge>
        ))
      )}
      {machine ? (
        <Badge variant="secondary">
          <BotIcon aria-hidden />
          Open to integrations
        </Badge>
      ) : null}
    </>
  );
}

/**
 * One tag, as a collapsible section.
 *
 * Collapsed by default. There are around two hundred endpoints across ten tags,
 * and a flat list means scrolling past Access management to reach anything else
 * — the tag names are the map, so they have to be visible at once before any of
 * them expands.
 *
 * Deliberately a button and a list rather than a `<select>` or a Radix dropdown.
 * A dropdown holds one panel open at a time and closes on choosing, which is
 * wrong here: comparing two endpoints in the same tag is the normal case, and the
 * list has to stay put while the detail beside it changes.
 */
function EndpointGroup({
  endpoints,
  expanded,
  onSelect,
  onToggle,
  selectedId,
  tag,
}: {
  endpoints: Endpoint[];
  expanded: boolean;
  onSelect: (id: string) => void;
  onToggle: () => void;
  selectedId: string | undefined;
  tag: string;
}) {
  const listId = `${useId()}-endpoints`;
  const holdsSelection = endpoints.some((endpoint) => endpoint.id === selectedId);

  return (
    <div>
      <button
        aria-controls={listId}
        aria-expanded={expanded}
        className="hover:bg-accent/60 focus-visible:ring-ring flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left outline-none focus-visible:ring-2"
        onClick={onToggle}
        type="button"
      >
        <ChevronRightIcon
          aria-hidden
          className={cn('size-3.5 shrink-0 transition-transform', expanded && 'rotate-90')}
        />
        <span className="min-w-0 flex-1 truncate text-xs font-medium tracking-wide uppercase">
          {tag}
        </span>
        {/* A dot when the open endpoint lives in here. Without it, collapsing the
            group you are reading loses the only cue for where you are. */}
        {holdsSelection && !expanded ? (
          <span
            aria-label="contains the open endpoint"
            className="bg-primary size-1.5 rounded-full"
          />
        ) : null}
        <span className="text-muted-foreground text-xs tabular-nums">{endpoints.length}</span>
      </button>
      {expanded ? (
        <ul className="mt-0.5 space-y-0.5 pl-2" id={listId}>
          {endpoints.map((endpoint) => (
            <li key={endpoint.id}>
              <Button
                className={cn(
                  'h-auto w-full justify-start gap-2 px-2 py-1.5 text-left font-normal',
                  endpoint.id === selectedId && 'bg-accent text-accent-foreground',
                )}
                onClick={() => onSelect(endpoint.id)}
                variant="ghost"
              >
                <span
                  className={cn(
                    'w-12 shrink-0 font-mono text-[10px] font-semibold uppercase',
                    METHOD_TONE[endpoint.method],
                  )}
                >
                  {endpoint.method}
                </span>
                {/* The path wraps rather than truncating: the tail is the part
                    that distinguishes two routes on the same resource, so an
                    ellipsis lands on the only informative half. */}
                <span className="min-w-0 font-mono text-xs break-all">
                  {endpoint.path.replace(/^\/api\/v\d+/, '')}
                </span>
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function EndpointDetail({
  document,
  endpoint,
}: {
  document: ApiDocument | undefined;
  endpoint: Endpoint;
}) {
  const { method, operation, path } = endpoint;
  const permissions = operation['x-required-permissions'] ?? [];
  const bodySchema = operation.requestBody?.content?.['application/json']?.schema;
  const responses = Object.entries(operation.responses ?? {});

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={cn('font-mono text-sm font-semibold uppercase', METHOD_TONE[method])}
          >
            {method}
          </span>
          <span className="font-mono text-sm break-all">{path}</span>
        </div>
        {operation.summary || operation.description ? (
          <p className="text-muted-foreground text-sm text-pretty">
            {operation.description || operation.summary}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-1.5">
          <AuthenticationBadges operation={operation} />
          {permissions.map((permission) => (
            <Badge key={permission}>{formatPermission(permission)}</Badge>
          ))}
          {permissions.length === 0 && (operation['x-authentication']?.length ?? 0) > 0 ? (
            <Badge variant="secondary">Any authenticated caller</Badge>
          ) : null}
        </div>
      </div>

      <Tabs defaultValue="reference">
        <TabsList>
          <TabsTrigger value="reference">Reference</TabsTrigger>
          <TabsTrigger value="console">Try it</TabsTrigger>
        </TabsList>

        <TabsContent className="space-y-5 pt-4" value="reference">
          <section className="space-y-2">
            <SectionHeader title="Parameters" />
            {operation.parameters?.length ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>In</TableHead>
                    <TableHead>Notes</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {operation.parameters.map((parameter) => {
                    const schema = resolveSchema(parameter.schema, document);
                    return (
                      <TableRow key={`${parameter.in}-${parameter.name}`}>
                        <TableCell className="align-top font-mono text-xs">
                          {parameter.name}
                          {parameter.required ? (
                            <Badge className="ml-1.5 align-middle" variant="secondary">
                              required
                            </Badge>
                          ) : null}
                        </TableCell>
                        <TableCell className="text-muted-foreground align-top text-xs">
                          {parameter.in}
                        </TableCell>
                        <TableCell className="text-muted-foreground align-top text-xs">
                          {parameter.description ? <p>{parameter.description}</p> : null}
                          {schema?.enum?.length ? <p>One of: {schema.enum.join(', ')}</p> : null}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            ) : (
              <p className="text-muted-foreground text-sm">This endpoint takes no parameters.</p>
            )}
          </section>

          <section className="space-y-2">
            <SectionHeader title="Request body" />
            {bodySchema ? (
              <SchemaTable document={document} schema={bodySchema} />
            ) : (
              <p className="text-muted-foreground text-sm">This endpoint takes no request body.</p>
            )}
          </section>

          <section className="space-y-2">
            <SectionHeader title="Responses" />
            {responses.length ? (
              <ul className="space-y-1.5">
                {responses.map(([status, response]) => (
                  <li className="flex gap-3 text-sm" key={status}>
                    <span className="font-mono text-xs tabular-nums">{status}</span>
                    <span className="text-muted-foreground">
                      {response.description || 'No description published.'}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-muted-foreground text-sm">No responses are documented.</p>
            )}
          </section>

          <section className="space-y-2">
            <SectionHeader
              description="The operation exactly as the API describes itself, including the authorization annotations."
              title="Raw definition"
            />
            <JsonView value={operation} />
          </section>
        </TabsContent>

        <TabsContent className="pt-4" value="console">
          <EndpointConsole
            document={document}
            method={method}
            operation={operation}
            path={path}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/**
 * The API, documented from the API.
 *
 * Generated from the live OpenAPI document rather than written alongside the
 * code, so it cannot describe an endpoint that no longer exists or miss one that
 * was added yesterday. The authorization annotations come from the same guard
 * metadata the guards themselves read.
 */
export default function ApiReferencePage() {
  const documentQuery = useOpenApiDocument();
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Everything starts closed, and nothing is auto-selected: the point of the
  // section list is that the tag names are what you see first.
  const [openTags, setOpenTags] = useState<Set<string>>(new Set());

  const endpoints = useMemo(() => flatten(documentQuery.data), [documentQuery.data]);
  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return endpoints;
    return endpoints.filter((endpoint) =>
      [
        endpoint.path,
        endpoint.method,
        endpoint.tag,
        endpoint.operation.summary ?? '',
        ...(endpoint.operation['x-required-permissions'] ?? []),
      ]
        .join(' ')
        .toLowerCase()
        .includes(term),
    );
  }, [endpoints, search]);

  const grouped = useMemo(() => {
    const groups = new Map<string, Endpoint[]>();
    for (const endpoint of filtered)
      groups.set(endpoint.tag, [...(groups.get(endpoint.tag) ?? []), endpoint]);
    return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right));
  }, [filtered]);

  // Resolved against every endpoint rather than the filtered set, so narrowing
  // the search to look something else up does not blank the endpoint you are
  // reading.
  const selected = endpoints.find((endpoint) => endpoint.id === selectedId);
  const unannotated = documentQuery.data?.['x-unannotated-operations'] ?? [];

  const searching = search.trim().length > 0;
  // A search whose results are hidden behind collapsed headers is a search that
  // does not work, so matching groups open themselves — and close again when the
  // box is cleared, without disturbing whatever the reader had opened by hand.
  const isExpanded = (tag: string) => searching || openTags.has(tag);
  const toggleTag = (tag: string) => {
    const next = new Set(openTags);
    if (next.has(tag)) next.delete(tag);
    else next.add(tag);
    setOpenTags(next);
  };

  if (documentQuery.isPending) return <PageSkeleton />;
  if (documentQuery.isError)
    return <ErrorState error={documentQuery.error} retry={() => void documentQuery.refetch()} />;

  return (
    <>
      <PageHeader
        badges={
          <>
            <Badge variant="secondary">{endpoints.length} endpoints</Badge>
            <Badge variant="secondary">v{documentQuery.data?.info.version}</Badge>
          </>
        }
        description="Every route this deployment serves, generated from the running API — including the permission each one enforces and whether third-party keys can reach it."
        title="API reference"
      />

      <Alert variant="warning">
        <AlertTitle>This console talks to the live API</AlertTitle>
        <AlertDescription>
          Requests sent from here use your own session and your own permissions, and are recorded in
          the audit trail under your name. There is no separate sandbox.
        </AlertDescription>
      </Alert>

      {unannotated.length > 0 ? (
        <Alert className="mt-3" variant="destructive">
          <AlertTitle>
            {unannotated.length} operation{unannotated.length === 1 ? '' : 's'} could not be read
          </AlertTitle>
          <AlertDescription>
            The backend could not match {unannotated.length === 1 ? 'it' : 'them'} to route
            metadata, so the authorization shown for {unannotated.length === 1 ? 'it' : 'them'} is
            unknown rather than absent. Treat the badges on those endpoints as missing information,
            not as evidence that nothing is enforced: {unannotated.slice(0, 5).join(', ')}
            {unannotated.length > 5 ? ` and ${unannotated.length - 5} more` : ''}.
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="mt-4 grid gap-4 lg:grid-cols-[22rem_1fr]">
        <Card className="lg:sticky lg:top-4 lg:max-h-[calc(100vh-8rem)] lg:self-start">
          <CardHeader className="gap-2">
            <CardTitle className="text-sm">Endpoints</CardTitle>
            <div className="relative">
              <SearchIcon
                aria-hidden
                className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2"
              />
              <Input
                aria-label="Search endpoints"
                className="pl-8"
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Path, method or permission"
                value={search}
              />
            </div>
          </CardHeader>
          <CardContent className="overflow-y-auto">
            {grouped.length === 0 ? (
              <p className="text-muted-foreground py-6 text-center text-sm">
                No endpoint matches “{search}”.
              </p>
            ) : (
              <div className="space-y-0.5">
                {grouped.map(([tag, group]) => (
                  <EndpointGroup
                    endpoints={group}
                    expanded={isExpanded(tag)}
                    key={tag}
                    onSelect={setSelectedId}
                    onToggle={() => toggleTag(tag)}
                    selectedId={selected?.id}
                    tag={tag}
                  />
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            {selected ? (
              <EndpointDetail document={documentQuery.data} endpoint={selected} />
            ) : (
              <p className="text-muted-foreground text-sm">Select an endpoint to see its contract.</p>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
