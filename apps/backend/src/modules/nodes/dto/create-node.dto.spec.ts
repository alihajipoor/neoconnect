import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { ISO_COUNTRY_CODES } from "../../../common/iso-countries";
import { CreateNodeDto, regionProblem } from "./create-node.dto";

const dtoFor = (region: unknown) =>
  plainToInstance(CreateNodeDto, { name: "node-1", role: "STANDALONE", region, publicIp: "192.0.2.10" });

/** Validated as the app's global pipe does. */
async function regionErrors(region: unknown): Promise<string[]> {
  const errors = await validate(dtoFor(region), { whitelist: true, forbidNonWhitelisted: true });
  return errors.flatMap((e) => Object.values(e.constraints ?? {}));
}

/** The apps read a server's country off the front of its region label, and
 * carry a flag and a name for every ISO country. A label that names none
 * is a globe in apps already released, so it is refused where it is typed. */
describe("CreateNodeDto: the region label", () => {
  /** Every label in the fleet today, and the shapes a new one may take. */
  it("accepts a country's ISO code, a dash and a name", async () => {
    for (const region of [
      "de-germany",
      "fi-finland",
      "fr-france",
      "gb-united-kingdom",
      "in-india",
      "ir-iran",
      "nl-netherlands",
      "se-sweden",
      "sg-singapore",
      "tr-turkey",
      "us-new-york",
      "kr-seoul-2",
    ]) {
      expect(await regionErrors(region)).toEqual([]);
    }
  });

  it("accepts all 249 countries and nothing else two letters long", () => {
    expect(ISO_COUNTRY_CODES.size).toBe(249);
    for (const code of ISO_COUNTRY_CODES) {
      expect(code).toMatch(/^[a-z]{2}$/);
      expect(regionProblem(`${code}-somewhere`)).toBeNull();
    }
    let accepted = 0;
    for (let a = 97; a <= 122; a++) {
      for (let b = 97; b <= 122; b++) {
        if (regionProblem(`${String.fromCharCode(a, b)}-somewhere`) === null) accepted++;
      }
    }
    expect(accepted).toBe(249);
  });

  /** Each of these was a globe, or another country's flag, in the apps. */
  it("refuses a label that names no country", async () => {
    for (const region of [
      "uk-london",
      "el-athens",
      "xk-pristina",
      "zz-nowhere",
      "eu-west",
      "frankfurt",
      "deu-frankfurt",
      "de",
      "de-",
      "-germany",
      "de--germany",
      "de_germany",
      "de.frankfurt",
      "de frankfurt",
      "No region",
      "St Petersburg",
      "",
    ]) {
      expect(await regionErrors(region)).toHaveLength(1);
    }
  });

  /** Capitals and stray spaces are put right, not refused: the apps read
   * the label without regard to either, and one form is what is stored. */
  it("stores the label trimmed and in lower case", async () => {
    expect(await regionErrors("  SE-Stockholm ")).toEqual([]);
    expect(dtoFor("  SE-Stockholm ").region).toBe("se-stockholm");
    // And the capital does not get a non-country through.
    expect(await regionErrors("UK-London")).toHaveLength(1);
  });

  it("refuses a region that is missing or not text, with one message and no crash", async () => {
    for (const region of [undefined, null, 5, {}, ["de-germany"]]) {
      expect(await regionErrors(region)).toHaveLength(1);
    }
  });

  /** The message is all the person adding the server sees: the panel shows
   * it as it is, and so does the installer. */
  it("says what to type", async () => {
    expect((await regionErrors("Frankfurt"))[0]).toContain("like fi-finland");
    const [uk] = await regionErrors("uk-london");
    expect(uk).toContain('"uk" is not one');
    expect(uk).toContain("the United Kingdom is gb");
  });
});
