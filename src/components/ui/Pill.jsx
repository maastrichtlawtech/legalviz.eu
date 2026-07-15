/**
 * Small uppercase status/label pill (e.g. act type, "in force", AI/beta, corrigendum, repealed).
 */
const VARIANT_CLASSES = {
  reg: "bg-eu-blue-soft text-eu-blue dark:bg-eu-blue-soft-dark dark:text-eu-blue-bright",
  ok: "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300",
  beta: "bg-eu-gold-soft text-eu-gold-deep dark:bg-eu-gold-soft-dark dark:text-eu-gold-bright",
  corr: "bg-eu-gold-soft text-eu-gold-deep dark:bg-eu-gold-soft-dark dark:text-eu-gold-bright",
  muted: "bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400",
};

export const Pill = ({ variant = "reg", children, className = "" }) => (
  <span
    className={
      `inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide ` +
      (VARIANT_CLASSES[variant] || VARIANT_CLASSES.reg) +
      " " +
      className
    }
  >
    {variant === "ok" && (
      <span className="h-1.5 w-1.5 rounded-full bg-green-600 dark:bg-green-400" />
    )}
    {children}
  </span>
);
