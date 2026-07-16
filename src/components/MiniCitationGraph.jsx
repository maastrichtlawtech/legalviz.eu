import { buildLawDisplayLabel } from "../utils/lawDisplay.js";

const CENTRE = { x: 180, y: 108 };
const NODE_POSITIONS = [
  { x: 112, y: 34 },
  { x: 198, y: 27 },
  { x: 267, y: 52 },
  { x: 294, y: 112 },
  { x: 250, y: 169 },
  { x: 158, y: 188 },
  { x: 76, y: 153 },
  { x: 58, y: 91 },
];

function compactLawLabel(law) {
  const { label } = buildLawDisplayLabel(law);
  const [shortTitle, reference] = label.split(" — ");
  if (reference) return shortTitle.length <= 18 ? shortTitle : reference.replace(/^[^(]+\(EU\)\s*/i, "");
  return label.replace(/^(Regulation|Directive|Decision)\s*\(EU\)\s*/i, "");
}

function nodeRadius(provisions) {
  return Math.max(5, Math.min(10, 4 + Math.sqrt(Number(provisions) || 1)));
}

/**
 * A deliberately static citation preview: the API has already ranked the
 * laws, so fixed positions are clearer and cheaper than a force simulation.
 * Navigation remains in the adjacent list to avoid duplicate keyboard stops.
 */
export function MiniCitationGraph({ laws = [], total = 0, centreLabel, ariaLabel, formatMore }) {
  const visible = laws.slice(0, NODE_POSITIONS.length);
  const hiddenCount = Math.max(0, total - visible.length);
  const centreText = String(centreLabel || "EU law").trim().slice(0, 12);

  if (!visible.length) return null;

  return (
    <figure className="flex min-h-64 flex-col justify-center border-t border-gray-100 px-3 py-4 dark:border-gray-800 md:border-l md:border-t-0">
      <svg
        viewBox="0 0 360 216"
        role="img"
        aria-label={ariaLabel}
        className="mx-auto block h-auto w-full max-w-[390px]"
      >
        <g className="stroke-eu-blue/35 dark:stroke-eu-blue-bright/40" strokeWidth="1.5">
          {visible.map((law, index) => {
            const position = NODE_POSITIONS[index];
            return (
              <line
                key={`line-${law.celex}`}
                x1={CENTRE.x}
                y1={CENTRE.y}
                x2={position.x}
                y2={position.y}
              />
            );
          })}
        </g>

        {visible.map((law, index) => {
          const position = NODE_POSITIONS[index];
          const onLeft = position.x < CENTRE.x;
          const radius = nodeRadius(law.provisions);
          return (
            <g key={law.celex}>
              <circle
                cx={position.x}
                cy={position.y}
                r={radius}
                className="fill-eu-blue dark:fill-eu-blue-bright"
              />
              <text
                x={position.x + (onLeft ? -radius - 5 : radius + 5)}
                y={position.y + 3}
                textAnchor={onLeft ? "end" : "start"}
                className="fill-gray-500 text-[8.5px] dark:fill-gray-400"
              >
                {compactLawLabel(law)}
              </text>
            </g>
          );
        })}

        <circle
          cx={CENTRE.x}
          cy={CENTRE.y}
          r="19"
          className="fill-eu-navy dark:fill-gray-100"
        />
        <text
          x={CENTRE.x}
          y={CENTRE.y + 3}
          textAnchor="middle"
          className="fill-white text-[8px] font-semibold dark:fill-eu-navy"
        >
          {centreText}
        </text>
      </svg>
      {hiddenCount > 0 ? (
        <figcaption className="text-center text-[11px] text-gray-400 dark:text-gray-500">
          {formatMore?.(hiddenCount) || `+${hiddenCount}`}
        </figcaption>
      ) : null}
    </figure>
  );
}
