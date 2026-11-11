/** Every ISO 3166-1 alpha-2 country code, lower case: all 249.
 *
 * The apps carry a flag, a name and a place on the map for exactly these
 * (`apps/desktop-windows/src/lib/country-names.ts`), and read which one a
 * server is in off the front of its region label. `flags.test.ts` there
 * fails if this list and the apps' differ -- a code missing here would
 * refuse a real country, and an extra one would let in a label the apps
 * can only draw as a globe.
 *
 * Not here on purpose: `uk` (the United Kingdom is `gb`), `el` (Greece is
 * `gr`) and `xk` (Kosovo, which the standard has not assigned). */
export const ISO_COUNTRY_CODES: ReadonlySet<string> = new Set(
  `ad ae af ag ai al am ao aq ar as at au aw ax az ba bb bd be bf bg bh bi
   bj bl bm bn bo bq br bs bt bv bw by bz ca cc cd cf cg ch ci ck cl cm cn
   co cr cu cv cw cx cy cz de dj dk dm do dz ec ee eg eh er es et fi fj fk
   fm fo fr ga gb gd ge gf gg gh gi gl gm gn gp gq gr gs gt gu gw gy hk hm
   hn hr ht hu id ie il im in io iq ir is it je jm jo jp ke kg kh ki km kn
   kp kr kw ky kz la lb lc li lk lr ls lt lu lv ly ma mc md me mf mg mh mk
   ml mm mn mo mp mq mr ms mt mu mv mw mx my mz na nc ne nf ng ni nl no np
   nr nu nz om pa pe pf pg ph pk pl pm pn pr ps pt pw py qa re ro rs ru rw
   sa sb sc sd se sg sh si sj sk sl sm sn so sr ss st sv sx sy sz tc td tf
   tg th tj tk tl tm tn to tr tt tv tw tz ua ug um us uy uz va vc ve vg vi
   vn vu wf ws ye yt za zm zw`.split(/\s+/),
);
