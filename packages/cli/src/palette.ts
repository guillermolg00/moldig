/**
 * Colour, without a dependency (the package ships none). D20: `NO_COLOR` and `TERM=dumb` stand
 * colour down, so does a stdout that is not a terminal; `FORCE_COLOR` turns it back on. When
 * colour is off every paint is the identity function, so the report is byte-for-byte plain.
 */

export type Paint = (text: string) => string;

export interface Palette {
  readonly enabled: boolean;
  readonly bold: Paint;
  readonly dim: Paint;
  readonly red: Paint;
  readonly yellow: Paint;
  readonly cyan: Paint;
  readonly green: Paint;
}

const ESC = "\u001B[";
const plain: Paint = (text) => text;

function sgr(open: number, close: number): Paint {
  return (text) => `${ESC}${open}m${text}${ESC}${close}m`;
}

export interface ColourInput {
  isTTY: boolean;
  env: Readonly<Record<string, string | undefined>>;
}

/** D20, in the order chalk resolves them: `FORCE_COLOR` wins, then `NO_COLOR`, then `TERM`. */
export function colourEnabled({ isTTY, env }: ColourInput): boolean {
  const force = env["FORCE_COLOR"];
  if (force !== undefined && force !== "") return force !== "0" && force !== "false";
  const no = env["NO_COLOR"];
  if (no !== undefined && no !== "") return false;
  if (env["TERM"] === "dumb") return false;
  return isTTY;
}

export function createPalette(input: ColourInput): Palette {
  if (!colourEnabled(input)) {
    return {
      enabled: false,
      bold: plain,
      dim: plain,
      red: plain,
      yellow: plain,
      cyan: plain,
      green: plain,
    };
  }
  return {
    enabled: true,
    bold: sgr(1, 22),
    dim: sgr(2, 22),
    red: sgr(31, 39),
    yellow: sgr(33, 39),
    cyan: sgr(36, 39),
    green: sgr(32, 39),
  };
}
