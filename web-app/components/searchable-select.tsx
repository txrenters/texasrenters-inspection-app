'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';

export type SearchableSelectOption = {
  value: string;
  label: string;
  searchText?: string;
};

export function SearchableSelect({
  id,
  value,
  options,
  placeholder,
  searchPlaceholder = 'Search…',
  emptyMessage = 'No matching options.',
  clearLabel,
  disabled = false,
  hasMore = false,
  loadingMore = false,
  selectedOption,
  optionsLabel = 'Options',
  loadingMoreLabel = 'Loading more options…',
  moreHint = 'Scroll for more options',
  onChange,
  onSearch,
  onLoadMore,
}: {
  id: string;
  value: string;
  options: SearchableSelectOption[];
  placeholder: string;
  searchPlaceholder?: string;
  emptyMessage?: string;
  clearLabel?: string;
  disabled?: boolean;
  hasMore?: boolean;
  loadingMore?: boolean;
  selectedOption?: SearchableSelectOption;
  optionsLabel?: string;
  loadingMoreLabel?: string;
  moreHint?: string;
  onChange: (value: string) => void;
  onSearch?: (query: string) => void;
  onLoadMore?: () => void;
}) {
  const listboxId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [selectedCache, setSelectedCache] = useState<SearchableSelectOption>();
  const availableOptions = useMemo(
    () => (clearLabel ? [{ value: '', label: clearLabel }, ...options] : options),
    [clearLabel, options],
  );
  const selected =
    availableOptions.find((option) => option.value === value) ??
    (selectedCache?.value === value ? selectedCache : undefined) ??
    (selectedOption?.value === value ? selectedOption : undefined);
  const matches = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return availableOptions;
    return availableOptions.filter((option) =>
      `${option.label} ${option.searchText ?? ''}`.toLocaleLowerCase().includes(normalized),
    );
  }, [availableOptions, query]);
  const visibleOptions = matches;

  useEffect(() => {
    function closeOnOutsideClick(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
        setQuery('');
        onSearch?.('');
      }
    }
    document.addEventListener('pointerdown', closeOnOutsideClick);
    return () => document.removeEventListener('pointerdown', closeOnOutsideClick);
  }, [onSearch]);

  useEffect(() => setActiveIndex(0), [query]);

  useEffect(() => {
    if (!open || !onSearch) return;
    const timer = window.setTimeout(() => onSearch(query.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [onSearch, open, query]);

  function select(option: SearchableSelectOption) {
    setSelectedCache(option);
    onChange(option.value);
    setOpen(false);
    setQuery('');
    onSearch?.('');
  }

  function openMenu() {
    if (disabled) return;
    setOpen(true);
    setQuery('');
    onSearch?.('');
  }

  return (
    <div ref={rootRef} className="searchable-select">
      <div className={`searchable-select-control${open ? ' is-open' : ''}`}>
        <svg
          className="searchable-select-search-icon"
          aria-hidden
          viewBox="0 0 24 24"
          width="18"
          height="18"
        >
          <circle cx="11" cy="11" r="6.5" />
          <path d="m16 16 4 4" />
        </svg>
        <input
          ref={inputRef}
          id={id}
          type="text"
          role="combobox"
          autoComplete="off"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-activedescendant={
            open && visibleOptions[activeIndex] ? `${listboxId}-option-${activeIndex}` : undefined
          }
          disabled={disabled}
          placeholder={open ? searchPlaceholder : placeholder}
          value={open ? query : (selected?.label ?? '')}
          onFocus={openMenu}
          onChange={(event) => {
            setOpen(true);
            setQuery(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              if (!open) openMenu();
              else setActiveIndex((index) => Math.min(index + 1, visibleOptions.length - 1));
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              setActiveIndex((index) => Math.max(index - 1, 0));
            } else if (event.key === 'Enter' && open && visibleOptions[activeIndex]) {
              event.preventDefault();
              select(visibleOptions[activeIndex]);
            } else if (event.key === 'Escape') {
              setOpen(false);
              setQuery('');
            }
          }}
        />
        <button
          type="button"
          className="searchable-select-toggle"
          aria-label={open ? `Close ${optionsLabel}` : `Open ${optionsLabel}`}
          disabled={disabled}
          tabIndex={-1}
          onClick={() => {
            if (open) {
              setOpen(false);
              setQuery('');
              onSearch?.('');
            } else {
              openMenu();
              inputRef.current?.focus();
            }
          }}
        >
          <svg aria-hidden viewBox="0 0 20 20" width="18" height="18">
            <path d="m5 7.5 5 5 5-5" />
          </svg>
        </button>
      </div>
      {open ? (
        <div
          className="searchable-select-menu"
          onScroll={(event) => {
            const element = event.currentTarget;
            const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
            if (nearBottom && hasMore && !loadingMore) onLoadMore?.();
          }}
        >
          <div id={listboxId} role="listbox" aria-label={optionsLabel}>
            {visibleOptions.map((option, index) => (
              <button
                key={option.value}
                id={`${listboxId}-option-${index}`}
                type="button"
                role="option"
                aria-selected={option.value === value}
                className={`searchable-select-option${index === activeIndex ? ' is-active' : ''}`}
                onPointerMove={() => setActiveIndex(index)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => select(option)}
              >
                <span>{option.label}</span>
                {option.value === value ? <span aria-hidden>✓</span> : null}
              </button>
            ))}
          </div>
          {!visibleOptions.length ? (
            <p className="searchable-select-empty">{emptyMessage}</p>
          ) : null}
          {loadingMore ? (
            <p className="searchable-select-hint" role="status">
              {loadingMoreLabel}
            </p>
          ) : hasMore ? (
            <p className="searchable-select-hint">{moreHint}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
