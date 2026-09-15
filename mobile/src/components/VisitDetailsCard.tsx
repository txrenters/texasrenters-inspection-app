import { ChevronDownIcon, ChevronUpIcon, KeyRoundIcon, MessageSquareIcon, PhoneIcon } from 'lucide-react-native';
import { useMemo, useState } from 'react';
import { Linking, Pressable, Text, View } from 'react-native';

import { Badge, Button, Card, PRESS_ROW } from '@/src/components/ui';
import { registerIcons } from '@/src/lib/icons';
import { visitDetailsView } from '@/src/utils/visit-details-view';

registerIcons(ChevronDownIcon, ChevronUpIcon, KeyRoundIcon, MessageSquareIcon, PhoneIcon);

/**
 * What the coordinator wrote on the Jobber visit, for the technician walking it.
 *
 * The filters to bring, who to call before arriving, the gate code: technicians
 * opened Jobber on the same phone for all of it. The text as written is one tap
 * away, because everything above it is a reading of free text.
 *
 * Only ever rendered for an inspection assigned to this technician -- the API
 * sends nothing else -- which is who a tenant's number and a way in are for.
 */
export function VisitDetailsCard({
  title,
  details,
  className = '',
}: {
  title?: string | null;
  details?: string | null;
  className?: string;
}) {
  const view = useMemo(() => visitDetailsView(details), [details]);
  const [expanded, setExpanded] = useState(false);
  if (!view) return null;

  return (
    <Card className={`gap-4 ${className}`}>
      <View className="gap-1">
        <Text className="text-base font-semibold text-foreground">Visit details</Text>
        {title ? <Text className="text-xs text-muted-foreground">{title}</Text> : null}
      </View>

      {view.inspectionNotNeeded ? (
        <View className="rounded-xl border border-chart-4/30 bg-chart-4/10 p-3">
          <Text className="text-xs font-semibold uppercase tracking-wide text-chart-4">
            Check with the office
          </Text>
          <Text className="mt-1 text-sm leading-relaxed text-foreground">
            The details say no occupied inspection is needed on this visit.
          </Text>
        </View>
      ) : null}

      {view.services.length ? (
        <View className="flex-row flex-wrap gap-2">
          {view.services.map((service) => (
            <Badge key={service} label={service} />
          ))}
        </View>
      ) : null}

      {view.filterChange ? (
        <View className="gap-1.5">
          <Label>Filters to bring</Label>
          {view.filters.length ? (
            view.filters.map((filter, index) => (
              <Text key={`${filter}-${index}`} className="text-sm font-semibold text-foreground">
                {filter}
              </Text>
            ))
          ) : (
            <Text className="text-sm text-foreground">No sizes given. Check the filters on site.</Text>
          )}
          {view.filterNotes.map((note, index) => (
            <Text key={index} className="text-sm text-muted-foreground">
              {note}
            </Text>
          ))}
        </View>
      ) : null}

      {view.tenants.length ? (
        <View className="gap-3">
          <Label>Tenant</Label>
          {view.contactBeforeArrival ? (
            <Text className="text-sm text-foreground">Let them know you are on your way.</Text>
          ) : null}
          {view.tenants.map((tenant) => (
            <View key={tenant.key} className="gap-2">
              <View>
                {tenant.unit ? <Text className="text-xs text-muted-foreground">{tenant.unit}</Text> : null}
                <Text className="text-sm font-semibold text-foreground">{tenant.name}</Text>
              </View>
              {tenant.phones.map((phone) => (
                <View key={phone.dial} className="flex-row gap-2">
                  <Button
                    variant="secondary"
                    label={phone.display}
                    accessibilityLabel={`Call ${tenant.name} at ${phone.display}`}
                    icon={<PhoneIcon size={16} className="text-foreground" />}
                    onPress={() => void Linking.openURL(`tel:${phone.dial}`)}
                    className="flex-1"
                  />
                  <Button
                    variant="secondary"
                    label="Text"
                    accessibilityLabel={`Text ${tenant.name} at ${phone.display}`}
                    icon={<MessageSquareIcon size={16} className="text-foreground" />}
                    onPress={() => void Linking.openURL(`sms:${phone.dial}`)}
                  />
                </View>
              ))}
            </View>
          ))}
        </View>
      ) : null}

      {view.accessNotes.length ? (
        <View className="gap-1.5">
          <Label>Getting in</Label>
          {view.accessNotes.map((note, index) => (
            <View key={index} className="flex-row items-start gap-2 rounded-xl bg-muted p-3">
              <KeyRoundIcon size={14} className="mt-0.5 text-muted-foreground" />
              <Text selectable className="flex-1 text-sm text-foreground">
                {note}
              </Text>
            </View>
          ))}
        </View>
      ) : null}

      {view.notes.length ? (
        <View className="gap-1.5">
          <Label>Notes</Label>
          {view.notes.map((note, index) => (
            <Text key={index} className="text-sm leading-relaxed text-foreground">
              {note}
            </Text>
          ))}
        </View>
      ) : null}

      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded((open) => !open)}
        className={`min-h-12 flex-row items-center justify-between ${PRESS_ROW}`}
      >
        <Text className="text-sm font-semibold text-primary">
          {expanded ? 'Hide the full details' : 'Show the full details'}
        </Text>
        {expanded ? (
          <ChevronUpIcon size={16} className="text-primary" />
        ) : (
          <ChevronDownIcon size={16} className="text-primary" />
        )}
      </Pressable>
      {expanded ? (
        <View className="gap-3">
          {view.completionSteps.length ? (
            <View className="gap-1">
              <Label>Completion steps</Label>
              {view.completionSteps.map((step, index) => (
                <Text key={index} className="text-sm leading-relaxed text-foreground">
                  {step}
                </Text>
              ))}
            </View>
          ) : null}
          <View className="rounded-xl bg-muted p-3">
            <Text selectable className="text-xs leading-relaxed text-muted-foreground">
              {view.raw}
            </Text>
          </View>
        </View>
      ) : null}
    </Card>
  );
}

function Label({ children }: { children: string }) {
  return (
    <Text className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{children}</Text>
  );
}
