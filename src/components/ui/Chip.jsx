/**
 * Inline monospace article-reference chip (e.g. "Art. 5"); renders a button when `onClick` is given.
 */
export const Chip = ({ children, onClick, className = "" }) => {
  const classes =
    `inline-block whitespace-nowrap rounded px-[7px] py-px font-mono text-[11px] text-eu-blue bg-eu-blue-soft dark:text-eu-blue-bright dark:bg-eu-blue-soft-dark ` +
    className;

  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={classes}>
        {children}
      </button>
    );
  }

  return <span className={classes}>{children}</span>;
};
