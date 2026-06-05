interface AccountRefProps {
  name: string;
  slug: string;
  onOpen: (slug: string) => void;
  count?: number;
}

export function AccountRef({ name, slug, onOpen, count }: AccountRefProps): JSX.Element {
  return (
    <button
      className="insight-account-chip"
      onClick={(e) => {
        e.stopPropagation();
        onOpen(slug);
      }}
    >
      {name}
      {count !== undefined && (
        <span style={{ opacity: 0.6, marginLeft: 2 }}>·{count}</span>
      )}
    </button>
  );
}
