# Embedding Prior Review

> **Semantic Neighbor 语义 = 同义/同类（alternative, same-class）**，由 embedding 相似度 +
> 元数据节点归属推导，**不是**标签共现（co-occurrence/NPMI）。`relation_type`
> （same_slot / same_parent / cross_slot）表达「同槽位/同父槽位/跨槽位」的语义替代关系。

## 0. Corrected Neighbor Quality Metrics（bge-m3，直接读自离线制品）

| metric | value |
|---|---|
| Must-Include Recall@10 | 0.2938（命中 52 / 目标 177） |
| Same-Slot Purity@10 | 0.8119（479 / 590） |
| Must-Avoid Violation Rate | 0.3051（18 / 59） |
| C-fixture 已评估条目 | 59 / 64（5 个 query tag 不在制品中） |

> 注：旧版报告的 `neighbor Precision@10 = found/10`（≈0.0881）为误导性指标，已移除；
> 上表为修正后的真实口径（§5.1/§5.2），数值直接从 `prior_semantic_neighbor` 行计算，
> 未调用 SiliconFlow API。

## 1. Semantic Neighbor Top-10 Validation (§49)

- **blue eyes**: red eyes(0.925), green eyes(0.915), white eyes(0.909), brown eyes(0.904), yellow eyes(0.903), purple eyes(0.900), grey eyes(0.891), black eyes(0.891), multicolored eyes(0.885), aqua eyes(0.882)
- **ponytail**: short ponytail(0.937), high ponytail(0.918), low ponytail(0.907), braided ponytail(0.903), twintails(0.901), side ponytail(0.895), folded ponytail(0.879), short twintails(0.876), low twintails(0.867), horse tail(0.866)
- **blush**: full-face blush(0.917), lipstick(0.863), various blushing faces(0.840), red lips(0.835), angry(0.835), smile(0.832), happy(0.830), confused(0.827), nose blush(0.824), annoyed(0.822)
- **kneeling**: squatting(0.906), standing(0.886), lying(0.883), sitting(0.864), leaning(0.858), kneeling on person(0.855), on stomach(0.852), standing on one leg(0.840), leaning back(0.839), leaning forward(0.834)
- **bedroom**: locker room(0.899), office(0.879), classroom(0.876), bathroom(0.875), toilet(0.874), bathtub(0.867), kitchen(0.864), indoors(0.848), shop(0.842), restaurant(0.832)
- **night**: evening(0.889), day(0.864), dusk(0.845), sunset(0.821), twilight(0.812), sunrise(0.795), morning(0.792), winter(0.792), dark(0.789), night vision effect(0.784)
- **moonlight**: sunlight(0.919), spotlight(0.884), glowing(0.881), light rays(0.875), backlighting(0.855), sunbeam(0.850), moon(0.825), neon lights(0.823), stage lights(0.817), dappled sunlight(0.810)
- **white dress**: white skirt(0.905), black dress(0.896), white apron(0.887), white sleeves(0.883), blue dress(0.881), white romper(0.871), white hoodie(0.869), white nightgown(0.867), grey dress(0.865), white pantyhose(0.864)

## 2. Bad-Neighbor Check (§50)

- **1girl**: 2girls(0.917), multiple girls(0.917), 1boy(0.910), 4girls(0.901), 3girls(0.896), 5girls(0.890), 1other(0.884), 6+girls(0.879), solo(0.856), 2boys(0.851)
- **solo**: solo focus(0.891), everyone(0.879), 1other(0.872), crowd(0.869), original(0.867), personification(0.860), couple(0.857), 1girl(0.856), multiple others(0.855), 2others(0.843)
- **masterpiece**: (not in corpus)
- **looking at viewer**: looking at object(0.907), facing viewer(0.896), looking at another(0.893), looking down(0.878), looking up(0.863), pointing at viewer(0.860), looking back(0.854), looking to the side(0.841), eye contact(0.832), looking afar(0.832)

## 3. Slot Validation Table (§51)

| tag | node | family | rule_source | confidence | embedding_score |
|---|---|---|---|---|---|
| blue eyes | char_eyes | eyes | seed | 0.90 | - |
| ponytail | char_hair | hair | seed | 0.90 | - |
| blush | char_expression | expression | seed | 0.90 | - |
| kneeling | char_pose | pose | taxonomy | 0.85 | - |
| bedroom | env_indoor | scene | seed | 0.90 | - |
| night | base_time_weather | time_weather | seed | 0.90 | - |
| moonlight | base_lighting | lighting | seed | 0.90 | - |
| white dress | char_clothing | clothing | seed | 0.90 | - |
| 1girl | char_identity | identity | seed | 0.90 | - |
| masterpiece | - | - | - | - | - |
| full body | char_body | body | seed | 0.90 | - |
| glasses | char_face | face | seed | 0.90 | - |
| beach | env_outdoor | scene | seed | 0.90 | - |
| sunset | base_time_weather | time_weather | seed | 0.90 | - |

## 4. Stratified Sample (§52)

| tag | node | rule_source | Top5 neighbors |
|---|---|---|---|
| fairy type theme (pokemon) | base_style | embedding | ghost type theme (pokemon), dragon type theme (pokemon), psychic type theme (pokemon), dark type theme (pokemon), fire type theme (pokemon) |
| michiru (dress) (blue archive) | char_identity | category | michiru (blue archive), aru (dress) (blue archive), ako (dress) (blue archive), hina (dress) (blue archive), saori (dress) (blue archive) |
| helen (starlit waltz) (girls' frontline 2) | char_identity | category | helen (girls' frontline 2), welrod (girls' frontline 2), florence (girls' frontline 2), loreley (girls' frontline 2), faelynn (girls' frontline 2) |
| bad math | unknown | unknown | bad aspect ratio, bad end, bad perspective, failure, bad source |
| eld jinn | char_identity | category | eren yeager, aile-kun, erune, eridian, nishida satono |
| yuri (gnosia) | char_identity | category | yuri (dy0urre1n), gnosia, jyuri (shouz), yuuri (arieko), yuri lowell |
| endless overhaul | char_identity | category | ei chan (endless overhaul), daichi (endless overhaul), manica (endless overhaul), revision, infinity symbol |
| star ciel (fate) | char_identity | category | tristan (third ascension) (fate), noah (third ascension) (fate), beowulf (third ascension) (fate), altera (third ascension) (fate), lilith (third ascension) (fate) |
| beloved zofia | unknown | unknown | sophia (ladyxiphilinos), sweet lolita, serafy, sophia (cieluscian), annika (salvika) |
| azuma shino (seihantai na kimi to boku) | char_identity | category | kimi no na wa., fushigi to kimi to library, mimi (ame to kimi to), tohno shiki, shino (kobun0) |
| maid kyouiku | char_identity | category | other maid, wa maid, male maid, maid day, enmaided |
| beatmania iidx 11 iidx red | char_identity | category | beatmania iidx 28 bistrover, beatmania iidx 8th style, beatmania iidx 22 pendual, beatmania iidx 13 distorted, beatmania iidx 14 gold |
| deluxe rosie (vtuber) | char_identity | category | vixi (vtuber), dorothree (vtuber), vera (vtuber), pixxi (vtuber), marimari (marimari 1.0) (vtuber) |
| fbi jacket | unknown | unknown | black jacket, white jacket, blue jacket, fur jacket, grey jacket |
| himawari (alphonse) | char_identity | category | honma himawari, himeji (himawari), kaworu (alphonse), furutani himawari, remon (alphonse) |
| nonki boy | char_identity | category | wolf boy, non non biyori, monkey boy, fox boy, tiger boy |
| melusine (celebratory attire) (fate) | char_identity | category | merlin (celebratory attire) (fate), tenochtitlan (celebratory attire) (fate), melusine (fate), lilith (celebratory attire) (fate), arjuna (celebratory attire) (fate) |
| soul fighter (league) | unknown | unknown | spirit blossom (league), wolf (league), summoner (league), talon (league), sylas (league) |
| holding ice pick | unknown | unknown | holding shaved ice, holding controller, holding ice cream, holding matchbox, holding scythe |
| chevalier d'eon (third ascension) (fate) | char_identity | category | jeanne d'arc (third ascension) (fate), david (third ascension) (fate), beowulf (third ascension) (fate), oberon (third ascension) (fate), archer (third ascension) (fate) |
| dick grayson (absolute dc) | char_identity | category | dick grayson, tim drake (absolute dc), duke thomas (absolute dc), robin (absolute dc), superman (absolute dc) |
| oberon (celebratory attire) (fate) | char_identity | category | barghest (celebratory attire) (fate), tenochtitlan (celebratory attire) (fate), merlin (celebratory attire) (fate), gareth (celebratory attire) (fate), oberon (fate) |
| ice cream on body | unknown | unknown | chocolate on body, ice cream, food on body, chocolate on breasts, holding ice cream |
| rainy mari | char_identity | category | lily mari, amayo liz, arty rain, maria kzy, pastel marie |
| iroi (summer dream) (nte) | char_identity | category | iroi (starlit night) (nte), timoris (bang dream!), iroi (nte), touhou tag dream, manatsu no yo no inmu |
| qc (utdr) | char_identity | category | blue soul (utdr), orange soul (utdr), purple soul (utdr), yellow soul (utdr), green soul (utdr) |
| kanjou x jingai | char_identity | category | isekaijoucho, furry with non-furry, jingai kyoshitsu no ningen girai kyoshi, ki ga hayai kouhai kanojo, kaiju |
| glowing ring | unknown | unknown | glowing weapon, glowing tattoo, glowing eye, glowing wings, glowing sword |
| bison (summer) (arknights) | char_identity | category | w (summer) (arknights), swire (summer) (arknights), gavial (summer) (arknights), amiya (summer) (arknights), lin (summer) (arknights) |
| kozakura inori | char_identity | category | yuzuriha inori, kozakura marry, hazakura ruri, utsumi sakura, inori (honkai gakuen) |
| chaos;child: children's revive | char_identity | category | chaos;child: children's collapse, chaos;child, chaos child syndrome, jake (chaos;child), beth (chaos;child) |
| oumiya emma (emma 2.0) | char_identity | category | oumiya emma (1st costume), sugisaki emma, mummy alma, nina saotome (nina 2.0), mei ema |
| north carolina (unique sunshine) (azur lane) | char_identity | category | st. louis (azur lane), new jersey (azur lane), bennington (sunshine chaser) (azur lane), azur lane, kansas (azur lane) |
| phantom maze monster (project sekai) | unknown | unknown | project sekai, overcome one's limits (project sekai), akumu no niwa wo utai akashite (project sekai), competitive fire! (project sekai), samenai gensou wo nokku shite (project sekai) |
| lydia eldridge | char_identity | category | clarissa oldrich, liese heldebrand, rias eidreise, lily orlamunde, leona heidern |
| zaun (league) | unknown | unknown | zaahen (league), zac (league), sion (league), swain (league), leona (league) |
| trian (kitagawa suigetsu) | char_identity | category | alice (kitagawa suigetsu), suigetsu, himorogi koyomi (kitagawa suigetsu), mizuhara rin (syunichi), mizutani mikoto (chacharan) |
| pink addison (deltarune) | char_identity | category | yellow addison (deltarune), ghost pink (deltarune), deltarune, elnina (deltarune), 7 colored flowers (deltarune) |
| nanado nado nado | char_identity | category | iroha nanairo (urushiushiru), rudo thana, nanami yachiyo, makoto nanaya, megido72 |
| hatsune miku (swimwear s) | char_identity | category | hatsune miku (swimwear), hatsune miku (swimwear b), hatsune miku (yukata style), hatsune miku, hatsune miku (polka dot bikini) |
| muted colors | base_style | taxonomy | cool colors, pastel colors, yellow theme, warm colors, green theme |
| death | unknown | unknown | death note, corpse, die of death, death reborn revolution, undead |
| trident | unknown | unknown | trigun, triangle, pennant, tricorne, triforce |
| white leg warmers | unknown | unknown | black leg warmers, white arm warmers, white pantyhose, see-through leg warmers, white leggings |
| sideways | base_composition | taxonomy | from side, profile, upside-down, from below, from above |
| attacking viewer | unknown | unknown | kicking viewer, punching viewer, attack, injecting viewer, kissing viewer |
| rubber boots | unknown | unknown | leather boots, belt boots, armored boots, platform boots, open-toe boots |
| ahri (league) | char_identity | category | ahri (league) (cosplay), ashe (league), azir (league), zeri (league), aurora (league) |
| industrial piercing | char_clothing_accessory | embedding | industrial pipe, piercing, ear covers, ear tattoo, earbuds |
| colored shadow | base_style | embedding | colorful background, shaded face, colored eyelashes, shade, shaded eye |
| leg armor | unknown | unknown | body armor, legs, leg tattoo, leg fur, leg belt |
| yellow armband | unknown | unknown | yellow sleeves, red armband, red cross armband, yellow sash, blue armband |
| prehensile hair | char_hair | embedding | convenient hair, patterned hair, glowing hair, liquid hair, adjusting hair |
| persona 3 portable | char_identity | category | persona 3, persona 3 reload, persona 2, persona, persona 6 |
| futa without pussy | unknown | unknown | futa without balls, futa with male, no pussy, futa on male, futa with futa |
| ribbed sleeves | unknown | unknown | striped sleeves, checkered sleeve cuffs, ribbed dress, sleeve ribbon, print sleeves |
| microsoft windows | char_identity | category | window (computing), windowsill, windows xp, open window, window shadow |
| mega man battle network (series) | char_identity | category | mega man x (series), mega man (series), mega man legends (series), mega man star force (series), mega man zero (series) |
| liquid hair | char_hair | embedding | liquid, chain headband, patterned hair, glowing hair, striped hair |
| moona hoshinova | char_identity | category | moona hoshinova (pajamas), moona hoshinova (goddess), celenova, moona hoshinova (holonatsu paradise), mona meria |
| holding skewer | unknown | unknown | holding fork, skewer, holding shovel, holding burger, holding spoon |
| yarn ball | unknown | unknown | yarn, ball, pom pom (clothes), tennis ball, ball chain |
| phantom of the kill | char_identity | category | phantom blood, cursemark of death, phantom alma, phantasm rod, phantom blood (movie) |
| yukishiro honoka | char_identity | category | yukinoshita yukino, amagi yukiko, amano yuika, tsukishiro yuki, nonoka (ransusan) |
| grusha (pokemon) | char_identity | category | guzma (pokemon), arezu (pokemon), grisham (pokemon), griselle (pokemon), gladion (pokemon) |
| yuuki yuuna wa yuusha de aru | char_identity | category | yuusha de aru, uehara yuuki, yuuki haru, yuusha ou gaogaigar, juusha (juusha-chan to yaya zannen na yuusha no hanashi) |
| fenomeno (umamusume) | char_identity | category | fenomeno (casual) (umamusume), fenomeno (gold-triumph) (umamusume), fenomeno (black flames of the righteous spirit) (umamusume), umamusume, genuine (umamusume) |
| youjo senki | char_identity | category | eiyuu senki, jashin senki r'lyeh shoujotai, senki zesshou symphogear, kyokkou senki mistletear, kouyoku senki exs-tia |
| marvel vs. capcom | char_identity | category | marvel vs. capcom 1, capcom vs. snk 2, marvel rivals, capcom vs. snk, capcom |
| revy (black lagoon) | char_identity | category | black lagoon, navi, black bikini, vivi and the magical island, silvia (black survival) |
| naruse shiroha | char_identity | category | shirase sakuya, narutaki nanairo, shirose isumi, shirase sayuki, anjou naruko |
| shirayuki hime | char_identity | category | shirayuki chiyo, shirayuki ren, shirayuki hina, shirayuki tomoe, shirase sayuki |
| jeanne d'arc (third ascension) (fate) | char_identity | category | jeanne d'arc alter (avenger) (third ascension) (fate), jeanne d'arc alter (avenger) (first ascension) (fate), jeanne d'arc (fate), jeanne d'arc alter (over the same sky) (fate), jeanne d'arc (ruler) (fate) |
| mr. c.b. (clear bliss) (umamusume) | char_identity | category | mr. c.b. (umamusume), mr. c.b. (casual) (umamusume), mejiro bright (brunissage line) (umamusume), mejiro bright (umamusume), titleholder (umamusume) |
| kitashirakawa chiyuri | char_identity | category | kitashirakawa chiyuri (alternate), kitashirakawa tamako, mizuhara chizuru, yoshikawa chinatsu, senkawa chihiro |
| nagomi yui | char_identity | category | nagomi (blue archive), narumi (hasturex), funami yui, ayato yui, naixue |
| utawarerumono: itsuwari no kamen | char_identity | category | utawarerumono (series), nisemonogatari, utawarerumono: chiriyuku mono e no komoriuta, nosuri (utawarerumono), ijimete ijimerarete |
| feature phone | unknown | unknown | fetish phone, showing phone, cellphone photo, phone holder, looking at phone |
| girls und panzer saishuushou | char_identity | category | girls und panzer, girls und panzer senshadou daisakusen!, marie (girls und panzer), aki (girls und panzer), andou (girls und panzer) |
| majora (zelda) | char_identity | category | ciela (zelda), giant's mask (zelda), the legend of zelda: majora's mask, midna, zol (zelda) |
| hands up | char_pose | embedding | hand up, offering hand, hand grip, own hands together, open hands |
| black shorts | unknown | unknown | grey shorts, black pants, blue shorts, white shorts, black panties |
| saliva | char_body | taxonomy | drooling, cum, facial, ejaculation, orgasm |
| cameltoe | unknown | unknown | camel pose, toes, toenails, horseshoe, cat paws |
| sex from behind | char_action | taxonomy | after sex, sex, doggystyle, vaginal, group sex |
| brown shoes | unknown | unknown | brown boots, brown socks, grey shoes, brown sandals, brown pants |
| box | unknown | unknown | gift box, holding box, box bag, box of chocolates, in box |
| eye contact | char_eyes | taxonomy | looking at object, looking at another, looking at viewer, tears, looking back |
| peaked cap | char_clothing_accessory | taxonomy | hood, beret, top hat, cowboy hat, sun hat |
| crying with eyes open | char_eyes | taxonomy | tearing up, tears, crying, wide-eyed, streaming tears |
| lace | unknown | unknown | lace gloves, lost lace, lace choker, lace trim, shoelaces |
| off-shoulder dress | char_clothing | taxonomy | off-shoulder shirt, backless dress, off shoulder, dress, strapless dress |
| blue gloves | char_clothing_accessory | embedding | grey gloves, black gloves, aqua gloves, red gloves, green gloves |
| print bikini | unknown | unknown | flag print bikini, floral print bikini, print bra, striped bikini, cow print bikini |
| city | env_outdoor | seed | urban, street, road, park, bridge |
| grey dress | char_clothing | embedding | black dress, brown dress, grey skirt, blue dress, grey hoodie |
| purple thighhighs | unknown | unknown | purple hiphighs, pink thighhighs, yellow thighhighs, orange thighhighs, brown thighhighs |
| lactation | unknown | unknown | breastfeeding, milk, lactation through clothes, feeding, breast pregnancy |
| red ascot | unknown | unknown | yellow ascot, green ascot, purple ascot, white ascot, pink ascot |
| low twin braids | char_hair | embedding | low twintails, low-braided long hair, short braided ponytail, low-tied long hair, low side ponytail |
| red pupils | char_eyes | embedding | blue pupils, yellow pupils, purple pupils, bright pupils, white pupils |
| architecture | unknown | unknown | building, apartment, east asian architecture, library, garden |
| red eyeliner | char_eyes | embedding | red eyeshadow, black eyeliner, red outline, red lineart, eyeliner |
| green halo | unknown | unknown | yellow halo, blue halo, grey halo, orange halo, red halo |
| blood on hand | unknown | unknown | blood on arm, scar on hand, blood on weapon, cum on hands, blood on knife |
| multiple hair bows | char_hair | embedding | bow-shaped hair, multicolored bow, bow hairband, multiple hair ribbons, multiple hairdressing |
| aiming | unknown | unknown | aiming at another, aiming at viewer, archery, optical sight, attack |
| animal ear headphones | unknown | unknown | animal ear earrings, animal ear headwear, animal ear hood, animal ear legwear, fake animal ears |
| lion ears | unknown | unknown | tiger ears, dragon ears, monkey ears, goat ears, sheep ears |
| pantyhose pull | unknown | unknown | pants pull, thighhighs pull, shorts pull, laddered pantyhose, blue pantyhose |
| robot joints | unknown | unknown | joints, robot animal, doll joints, clothed robot, super robot |
| unworn panties | unknown | unknown | no panties, unworn bra, unworn socks, untied panties, unworn clothes |
| pink necktie | unknown | unknown | pink bowtie, pink collar, blue necktie, red necktie, multicolored necktie |
| american flag | unknown | unknown | american flag print, japanese flag, flag, german flag, american flag bandana |
| frilled bra | unknown | unknown | frilled wristband, frilled panties, frilled sleeves, frilled arm strap, frilled collar |
| gold necklace | char_clothing_accessory | embedding | chain necklace, gold bracelet, pearl necklace, gold ring, gold chain |
| sideways mouth | unknown | unknown | :/, covered mouth, hand over own mouth, pursed lips, sideways hat |
| blue wings | unknown | unknown | red wings, black wings, white wings, grey wings, blue feathers |
| heart choker | char_clothing_accessory | embedding | heart shaped choker, flower choker, o-ring choker, star choker, anchor choker |
| stomach tattoo | unknown | unknown | breast tattoo, back tattoo, scar on stomach, leg tattoo, heart tattoo |
| 1girl | char_identity | seed | 2girls, multiple girls, 1boy, 4girls, 3girls |
| smile | char_expression | seed | laughing, happy, shy, crazy smile, grin |
| shirt | char_clothing | taxonomy | t-shirt, dress shirt, polo shirt, sweater, collared shirt |
| black hair | char_hair | taxonomy | white hair, grey hair, blue hair, brown hair, red hair |
| brown hair | char_hair | taxonomy | blue hair, grey hair, black hair, blonde hair, green hair |
| red eyes | char_eyes | taxonomy | blue eyes, yellow eyes, green eyes, multicolored eyes, white eyes |
| original | char_identity | taxonomy | solo, everyone, multiple others, crowd, 1other |
| very long hair | char_hair | taxonomy | very short hair, long hair, absurdly long hair, short hair, medium hair |
| full body | char_body | seed | upper body, lower body, cropped, ass focus, scenery |
| tail | char_body | taxonomy | fox tail, cat tail, dog tail, dragon tail, wolf tail |
| collarbone | char_body | taxonomy | hip bones, ribs, back, navel, belly |
| white hair | char_hair | taxonomy | black hair, blue hair, blonde hair, brown hair, grey hair |
| sidelocks | char_hair | taxonomy | short hair, long hair, single sidelock, single braided sidelock, side braid |
| flower | base_objects | seed | grass, rose, leaf, tree, sunflower |
| thighs | unknown | unknown | legs, thigh belt, between thighs, thigh pouch, hiphighs |
| ass | char_body | taxonomy | anus, breasts, nipples, completely nude, pussy |
| open clothes | char_clothing | taxonomy | open coat, open shirt, open jacket, adjusting clothes, wet clothes |
| pleated skirt | char_clothing | taxonomy | layered skirt, plaid skirt, skirt, frilled skirt, long skirt |
| nude | char_clothing | taxonomy | completely nude, clothed female nude female, bottomless, undressing, off shoulder |
| shorts | char_clothing_bottom | seed | short shorts, gym shorts, pants, denim shorts, bike shorts |
| wings | char_body | taxonomy | bird wings, angel wings, butterfly wings, fairy wings, dragon wings |
| pointy ears | char_face | taxonomy | sharp teeth, animal ears, ear piercing, pointy nose, earrings |
| hand up | char_pose | embedding | hands up, offering hand, hand grip, own hands together, holding flag |
| puffy sleeves | unknown | unknown | puffy short sleeves, puffy long sleeves, puff and slash sleeves, puffy detached sleeves, puff and slash pants |
| black thighhighs | unknown | unknown | grey thighhighs, brown thighhighs, blue thighhighs, white hiphighs, black hiphighs |
| 2boys | char_identity | taxonomy | multiple boys, 4boys, 1boy, 3boys, 5boys |
| hood | char_clothing_accessory | taxonomy | hat, sun hat, straw hat, headband, military hat |
| tongue out | char_pose | taxonomy | heavy breathing, oral, erection, ass, facial |
| elbow gloves | char_clothing_accessory | taxonomy | gloves, arm warmers, gloves over elbow gloves, fingerless gloves, handbag |
| hair flower | char_clothing_accessory | taxonomy | hair ornament, hair ribbon, flower, headband, hat |
| grey background | base_style | embedding | black background, blurry background, green background, white background, blue background |
| fingerless gloves | char_clothing_accessory | taxonomy | single fingerless glove, gloves, elbow gloves, unworn gloves, arm warmers |
| animal ear fluff | char_hair | embedding | animal ear hood, animal ear headphones, animal ear headwear, animal ear earrings, fake animal ears |
| spread legs | char_pose | taxonomy | legs apart, legs together, spread fingers, spread arms, wide spread legs |
| kimono | char_clothing | taxonomy | miko, hanfu, furisode, hanbok, qipao |
| red bow | unknown | unknown | blue bow, yellow bow, pink bow, green bow, purple bow |
| 3girls | char_identity | taxonomy | 4girls, 5girls, multiple girls, 2girls, 1girl |
| genshin impact | char_identity | category | canon (genshin impact), razor (genshin impact), noy (genshin impact), lohen (genshin impact), chongyun (genshin impact) |
| armor | base_objects | taxonomy | helmet, weapon, shield, sword, dagger |
| blue sky | env_outdoor | taxonomy | sky, starry sky, space, sun, galaxy |
