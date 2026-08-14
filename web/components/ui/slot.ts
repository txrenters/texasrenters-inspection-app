import { createSlot } from '@radix-ui/react-slot';
import type { ComponentProps } from 'react';

/**
 * Element-typed slots for `asChild`.
 *
 * The bare `Slot` export is declared as `React.HTMLAttributes<HTMLElement>`, so
 * `const Comp = asChild ? Slot : 'button'` fails to accept `ComponentProps
 * <'button'>` — `onChange` is `FormEventHandler<HTMLButtonElement>` on one side
 * and `FormEventHandler<HTMLElement>` on the other, and event handlers are
 * contravariant in their argument. It reports as a wall of "Type ... is not
 * assignable to type 'HTMLAttributes<HTMLElement>'" across every component that
 * supports `asChild`, which is misleading: nothing is wrong with the call sites.
 *
 * `createSlot<Elem, Props>` is the package's own answer — it builds a Slot typed
 * for the element it stands in for. These four cover every `asChild` in the app,
 * and no cast is involved, so a genuinely wrong prop is still an error.
 */
export const AnchorSlot = createSlot<HTMLAnchorElement, ComponentProps<'a'>>('AnchorSlot');
export const ButtonSlot = createSlot<HTMLButtonElement, ComponentProps<'button'>>('ButtonSlot');
export const DivSlot = createSlot<HTMLDivElement, ComponentProps<'div'>>('DivSlot');
export const SpanSlot = createSlot<HTMLSpanElement, ComponentProps<'span'>>('SpanSlot');
