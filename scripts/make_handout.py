"""Generate the trading-bot handout PDF.

    python scripts/make_handout.py [out.pdf]
"""
from __future__ import annotations

import sys

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import LETTER
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.platypus import (BaseDocTemplate, Frame, HRFlowable, KeepTogether,
                                ListFlowable, ListItem, NextPageTemplate, PageBreak,
                                PageTemplate, Paragraph, Spacer, Table, TableStyle)

OUT = sys.argv[1] if len(sys.argv) > 1 else "tradingbot/handout.pdf"

INK    = colors.HexColor("#12161C")
MUTED  = colors.HexColor("#5B6672")
RULE   = colors.HexColor("#D8DEE6")
BAND   = colors.HexColor("#F1F4F8")
ACCENT = colors.HexColor("#1F5FA8")
GO     = colors.HexColor("#1B7A46")
WARN   = colors.HexColor("#B45309")
STOP   = colors.HexColor("#B3261E")

ss = getSampleStyleSheet()


def S(name, **kw):
    base = dict(fontName="Helvetica", fontSize=9.5, leading=13.5, textColor=INK)
    base.update(kw)
    return ParagraphStyle(name, **base)


Body    = S("Body", spaceAfter=7)
Lead    = S("Lead", fontSize=10.5, leading=15.5, textColor=colors.HexColor("#333B45"), spaceAfter=9)
H1      = S("H1", fontName="Helvetica-Bold", fontSize=17, leading=21, spaceBefore=2, spaceAfter=3)
H2      = S("H2", fontName="Helvetica-Bold", fontSize=12.5, leading=16,
            spaceBefore=15, spaceAfter=5, textColor=ACCENT)
H3      = S("H3", fontName="Helvetica-Bold", fontSize=10, leading=13.5, spaceBefore=9, spaceAfter=3)
Small   = S("Small", fontSize=8.3, leading=11.5, textColor=MUTED)
Cell    = S("Cell", fontSize=8.4, leading=11.2)
CellB   = S("CellB", fontSize=8.4, leading=11.2, fontName="Helvetica-Bold")
CellH   = S("CellH", fontSize=8.2, leading=11, fontName="Helvetica-Bold", textColor=colors.white)
Mono    = S("Mono", fontName="Courier", fontSize=8.4, leading=11.8)
Kicker  = S("Kicker", fontName="Helvetica-Bold", fontSize=8, leading=10,
            textColor=ACCENT, spaceAfter=2)

story = []


def rule(space_before=3, space_after=8, color=RULE):
    story.append(Spacer(1, space_before))
    story.append(HRFlowable(width="100%", thickness=0.6, color=color, spaceAfter=space_after))


def bullets(items, style=Body, bullet="•", leftIndent=13):
    story.append(ListFlowable(
        [ListItem(Paragraph(t, style), leftIndent=leftIndent, value=bullet) for t in items],
        bulletType="bullet", start=bullet, leftIndent=leftIndent,
        bulletFontSize=8, spaceAfter=6,
    ))


def table(rows, widths, header=True, align=None, zebra=True, pad=5):
    data = []
    for r_i, row in enumerate(rows):
        out = []
        for c_i, cell in enumerate(row):
            if isinstance(cell, Paragraph):
                out.append(cell)
            else:
                st = CellH if (header and r_i == 0) else Cell
                out.append(Paragraph(str(cell), st))
        data.append(out)

    cmds = [
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), pad),
        ("BOTTOMPADDING", (0, 0), (-1, -1), pad),
        ("LINEBELOW", (0, 0), (-1, -2), 0.4, RULE),
    ]
    if header:
        cmds += [("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#2C3A4B"))]
        if zebra:
            for i in range(2, len(data), 2):
                cmds.append(("BACKGROUND", (0, i), (-1, i), colors.HexColor("#F7F9FC")))
    for a in (align or []):
        cmds.append(a)
    t = Table(data, colWidths=widths, hAlign="LEFT")
    t.setStyle(TableStyle(cmds))
    return t


def callout(title, body, color=ACCENT, bg=BAND):
    inner = [
        [Paragraph(f'<font color="{color.hexval()}"><b>{title}</b></font>', S("ct", fontSize=9.5, leading=13))],
        [Paragraph(body, S("cb", fontSize=9, leading=13))],
    ]
    t = Table(inner, colWidths=[6.9 * inch], hAlign="LEFT")
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), bg),
        ("LEFTPADDING", (0, 0), (-1, -1), 10), ("RIGHTPADDING", (0, 0), (-1, -1), 10),
        ("TOPPADDING", (0, 0), (-1, 0), 8), ("BOTTOMPADDING", (0, -1), (-1, -1), 9),
        ("TOPPADDING", (0, 1), (-1, 1), 1),
        ("LINEBEFORE", (0, 0), (0, -1), 2.5, color),
    ]))
    return t


# ══════════════════════════════════════════════════════════════════ COVER
story.append(Spacer(1, 4))
story.append(Paragraph("AUTOMATED CRYPTO TRADING SYSTEM", Kicker))
story.append(Paragraph("How the Bots Work", H1))
story.append(Paragraph(
    "Design rationale, evidence from 8 rounds of testing, tuning levers, and the "
    "criteria for putting real money at risk.", Lead))
rule(0, 10)

story.append(callout(
    "Read this first",
    "This system trades <b>simulated money</b> today. It stays that way until you deliberately "
    "add Robinhood credentials plus an acknowledgment secret. Nothing in this document is "
    "financial advice, and no result here is a prediction. Every performance figure comes from "
    "<i>synthetic</i> or <i>reconstructed</i> price data — not from live trading.",
    WARN, colors.HexColor("#FFF7ED")))
story.append(Spacer(1, 12))

story.append(Paragraph("The problem this solves", H2))
story.append(Paragraph(
    "Discretionary trading demands consistent attention at times a working physician cannot reliably "
    "give it. The failure isn't strategy — it's <b>adherence</b>: missed exits, position sizes chosen by "
    "mood, and losses held too long because closing one makes it real. A mechanical system fixes the "
    "rules while you are calm and executes them while you are not.", Body))
story.append(Paragraph(
    "The design goal was never maximum return. It was <b>bounded, survivable</b> return: a hard ceiling "
    "on how fast the account can lose, enforced by code that has no ego to protect.", Body))

story.append(Paragraph("Four design commitments", H2))
story.append(table([
    ["Commitment", "How it is enforced in code"],
    [Paragraph("<b>Cut losers fast,<br/>let winners run</b>", Cell),
     "Every position gets a stop at entry, 2.5×ATR below. Winners trail by 3×ATR and the "
     "trail only ratchets upward — it never loosens. Losses are capped near 1R; gains are open-ended."],
    [Paragraph("<b>Risk a fixed<br/>fraction, not a<br/>fixed dollar</b>", Cell),
     "Size = (equity × 2%) ÷ stop distance. Because it reads <i>current</i> equity every day, "
     "position sizes compound up after gains and shrink after losses automatically."],
    [Paragraph("<b>Hard drawdown<br/>circuit breakers</b>", Cell),
     "3% in a day or 5% in a week from the high-water mark → flatten everything, "
     "block new entries until the next day / ISO week. Not a suggestion; a hard gate."],
    [Paragraph("<b>Respond to trend<br/>changes quickly</b>", Cell),
     "Entries require an EMA cross <i>and</i> price above the 100-day regime filter. "
     "Exits fire on the cross-down without waiting for confirmation."],
], [1.28 * inch, 5.62 * inch]))

story.append(Paragraph("A worked example", H2))
story.append(Paragraph(
    "$10,000 account. BTC at $62,000, ATR $2,400. Risk budget = 2% = <b>$200</b>. Stop distance = "
    "2.5 × $2,400 = $6,000, so the stop sits at $56,000 and you buy $200 ÷ $6,000 = <b>0.0333 BTC</b> "
    "(about $2,067 of exposure).", Body))
story.append(Paragraph(
    "If BTC falls to $56,000 you lose ~$200 — <b>2% of the account, not 10%</b>, even though BTC "
    "itself dropped 10%. That gap is the entire point of ATR sizing. If instead BTC runs to $80,000, "
    "the trail follows it up and you exit near $72,800 for roughly +$620 — <b>a +3.1R win against a "
    "1R risk</b>. You can be right well under half the time and still profit.", Body))

story.append(NextPageTemplate("body"))
story.append(PageBreak())

# ══════════════════════════════════════════════════════════════ THE BOTS
story.append(Paragraph("The four bots", H1))
story.append(Paragraph(
    "All four share the identical risk engine — same sizing formula, same stops, same circuit "
    "breakers. They differ <i>only</i> in what they consider a trend worth entering. That isolation "
    "is deliberate: it makes them genuinely comparable, and it means a risk fix improves all four "
    "at once.", Body))
story.append(Spacer(1, 4))

story.append(table([
    ["Bot", "Entry trigger", "Character"],
    [Paragraph("<b>ema_atr_trend</b><br/><font size=7.5 color='#5B6672'>12/48 EMA, 100 regime</font>", Cell),
     "Fast EMA crosses above slow EMA, while price is above the 100-day EMA.",
     "The steady one. Fewest trades, most consistent. The regime filter keeps it out of falling markets."],
    [Paragraph("<b>donchian_breakout</b><br/><font size=7.5 color='#5B6672'>20/10 channel, ADX&gt;20</font>", Cell),
     "Price breaks above its 20-day high and ADX confirms real trend strength.",
     "The aggressive one. Biggest wins, biggest whipsaws. Classic turtle-trading logic."],
    [Paragraph("<b>momentum_regime</b><br/><font size=7.5 color='#5B6672'>10/30 ROC, vol filter</font>", Cell),
     "Short- and long-window rate-of-change both positive and accelerating; skips crash regimes.",
     "The cautious one. Explicitly sits out high-volatility crash conditions."],
    [Paragraph("<b>dual_momentum_adaptive</b><br/><font size=7.5 color='#5B6672'>KAMA + ROC</font>", Cell),
     "Adaptive (Kaufman) moving average flips direction with ROC confirmation.",
     "The opportunist. Tightens its trail from 3× to 2×ATR past +3R to bank large winners."],
], [1.55 * inch, 2.5 * inch, 2.85 * inch]))

story.append(Paragraph("How they were built and tested", H2))
story.append(Paragraph(
    "Nine rounds, each answering one question before the next began. The order matters: correctness "
    "was proven before performance was measured, and robustness before anything was frozen.", Body))

story.append(table([
    ["Round", "Question", "Finding"],
    ["0", "Do the circuit breakers actually fire?",
     "Framework plus unit tests proving 3%/5% breakers trip and reset correctly. 37 tests today."],
    ["1–2", "Do all four run? Does tuning help?",
     "Baselines set. Tuning made momentum_regime <i>worse</i> (−9.8% vs −1.1%); direction abandoned."],
    ["3–4", "Does the winner survive a different random market?",
     "Tested seeds 42/7/99. donchian breached the 5% weekly limit at 2% risk — capped it at 1%."],
    ["5", "Is the edge real or one lucky path?",
     Paragraph("<b>20 seeds:</b> 18/20 profitable, 18/20 inside the weekly limit, median +8.0%.", Cell)],
    ["6", "How would it have handled 2022–2024?",
     "Reconstructed LUNA/FTX crash → 2024 rally. Trailing stops exited the bear market; no breaker needed."],
    ["7", "Are the default parameters cherry-picked?",
     "27-combo grid found a 'better' setting — it won only 5/15 seeds. <b>Defaults kept.</b>"],
    ["8", "Which bot should actually run?",
     Paragraph("Head-to-head tournament. <b>The 4-bot ensemble won on risk-adjusted terms.</b>", Cell)],
], [0.5 * inch, 2.35 * inch, 4.05 * inch]))

story.append(PageBreak())

# ═════════════════════════════════════════════════════════ EVIDENCE
story.append(Paragraph("What the testing actually showed", H1))

story.append(Paragraph("Round 5 — the robustness check that matters most", H2))
story.append(Paragraph(
    "One bot (ema_atr_trend, 2% risk) run across 20 independently generated 2-year markets. "
    "The question isn't \"how much did it make\" — it's <b>how often did it fail, and how badly</b>.", Body))

story.append(table([
    ["Measure", "Result", "Reading"],
    ["Profitable markets", Paragraph("<b>18 / 20</b>", CellB), "Edge is not seed-specific"],
    ["Stayed inside 5% weekly limit", Paragraph("<b>18 / 20</b>", CellB), "Risk controls hold up"],
    ["Zero circuit-breaker trips", "17 / 20", "Breakers are a backstop, rarely needed"],
    ["Median 2-year return", Paragraph("<b>+8.0%</b>", CellB), "The realistic expectation"],
    ["10th-percentile return", Paragraph("<font color='#B45309'><b>−0.35%</b></font>", Cell),
     "A bad-but-not-rare outcome is roughly flat"],
    ["Worst market", Paragraph("<font color='#B3261E'><b>−7.6%</b></font>", Cell),
     "<b>This can happen to you</b>"],
    ["Best market", "+47.2%", "Do not plan around this"],
], [2.05 * inch, 1.15 * inch, 3.7 * inch],
    align=[("ALIGN", (1, 0), (1, -1), "CENTER")]))

story.append(Paragraph(
    "Read the median, not the maximum. <b>+8% over two years</b> is the honest center of the "
    "distribution. The +47% seed exists, but so does the −7.6% seed, and you cannot know in advance "
    "which market you are living in.", Body))

story.append(Paragraph("Round 8 — why four bots beat the best single bot", H2))

story.append(table([
    ["Bot", "Median return", "Markets profitable", "Worst weekly DD"],
    ["donchian_breakout", "+23.6%", Paragraph("<font color='#B3261E'>60%</font>", Cell),
     Paragraph("<font color='#B3261E'><b>6.63%  ✗ over limit</b></font>", Cell)],
    [Paragraph("<b>ENSEMBLE — all four, 25% each</b>", CellB),
     Paragraph("<b>+13.8%</b>", CellB),
     Paragraph("<font color='#1B7A46'><b>90%</b></font>", Cell),
     Paragraph("<font color='#1B7A46'><b>3.41%  ✓ best</b></font>", Cell)],
    ["dual_momentum_adaptive", "+14.4%", "90%", "3.56%"],
    ["momentum_regime", "+10.7%", "80%", "3.21%"],
    ["ema_atr_trend", "+8.0%", "80%", "4.65%"],
], [2.1 * inch, 1.15 * inch, 1.55 * inch, 2.1 * inch],
    align=[("ALIGN", (1, 0), (-1, -1), "CENTER")]))

story.append(Paragraph(
    "donchian posts the biggest median return and is the <b>wrong choice</b>. It loses money in 40% of "
    "markets and blows through the 5% weekly limit — the one rule the whole system exists to enforce. "
    "The ensemble gives up some upside and buys back consistency (90% of markets profitable) and the "
    "smallest worst-case drawdown of any option. The bots' losing streaks don't line up, so the "
    "portfolio is steadier than any single member.", Body))
story.append(Paragraph("<b>Your system runs the ensemble.</b> Each bot gets 25% of capital and its own "
                       "independent state file.", Body))

story.append(Spacer(1, 6))
story.append(callout(
    "Round 6 needs an asterisk",
    "The 2022–2024 replay returned +111% with Sharpe 6.8. <b>Do not anchor on that.</b> It was built by "
    "interpolating real monthly prices into daily bars, which produces smoother paths than real markets — "
    "and that period contained a once-a-cycle 4.4× recovery. What it <i>does</i> credibly show is "
    "<b>behaviour</b>: the bots trailed out of the bear market without needing a breaker, then re-entered "
    "on the recovery. Trust the behaviour, not the number.",
    WARN, colors.HexColor("#FFF7ED")))

story.append(PageBreak())

# ═══════════════════════════════════════════════════ DAY-TO-DAY BEHAVIOUR
story.append(Paragraph("What it does, day to day", H1))
story.append(Paragraph(
    "Once daily at 00:05 UTC (8:05pm ET) a GitHub Action wakes up, pulls fresh daily candles for "
    "BTC / ETH / SOL / AVAX, and runs each bot through the same sequence:", Body))

story.append(table([
    ["", "Step", "What happens"],
    ["1", "Mark to market", "Recalculate equity and drawdown from the day and week high-water marks."],
    ["2", "Check stops", "Any position whose low pierced its stop is sold at the actual broker fill price."],
    ["3", "Check breakers", "If daily DD ≥ 3% or weekly ≥ 5% → flatten everything, stop for the period."],
    ["4", "Check exits", "Signal reversal (e.g. EMA cross-down) closes the position."],
    ["5", "Ratchet trails", "Winning positions raise their trailing stop. It never moves down."],
    ["6", "Check entries", "New signals open positions — only if not halted and caps allow."],
    ["7", "Save + notify", "State written to the repo; a push notification goes to your phone."],
], [0.32 * inch, 1.28 * inch, 5.3 * inch]))

story.append(Paragraph("Reading your phone alert", H2))
story.append(Table([[Paragraph(
    "Tradebot 2026-08-25: 2 trades<br/>"
    "BUY BTC: 0.0403 @ $62,140.00 (stop $59,020.00)<br/>"
    "SELL SOL (stop): P&amp;L -$118.20 (-1.00R)<br/>"
    "Equity: $10,512.34<br/>"
    "DD day 1.20% / week 2.10%", Mono)]],
    colWidths=[6.9 * inch], style=TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#F5F7FA")),
        ("BOX", (0, 0), (-1, -1), 0.5, RULE),
        ("LEFTPADDING", (0, 0), (-1, -1), 10), ("RIGHTPADDING", (0, 0), (-1, -1), 10),
        ("TOPPADDING", (0, 0), (-1, -1), 9), ("BOTTOMPADDING", (0, 0), (-1, -1), 9),
    ])))
story.append(Spacer(1, 7))
bullets([
    "<b>R-multiple</b> is the number to watch, not dollars. <b>−1.00R</b> means the loss landed exactly "
    "where the stop was placed — the system worked. A <b>+3R</b> win pays for three such losses.",
    "<b>DD day / week</b> are your live distance to the 3% and 5% breakers.",
    "A title beginning <b>HALTED</b> means a breaker fired: positions were flattened, no new entries until "
    "the period rolls over. <b>This is the system working, not breaking.</b>",
    "In ensemble mode, quiet days are suppressed — no alert means no bot traded. Silence is normal.",
])

story.append(Paragraph("Behaviour you should expect — and not panic about", H2))
story.append(table([
    ["You will see", "Why it is normal"],
    ["Losing more trades than you win",
     "Win rates run ~26–43%. Profit comes from winners being multiples larger, not from being right often."],
    ["Long stretches with no trades",
     "The regime filter blocks entries in downtrends. Sitting out <i>is</i> the strategy working."],
    ["A stop hit the day before a rally",
     "Unavoidable. The alternative — widening stops — is how accounts get destroyed."],
    ["Drawdown slightly past the limit",
     "Daily bars can gap through a stop. The breaker halts further entries but cannot undo a gap."],
], [2.0 * inch, 4.9 * inch]))

story.append(PageBreak())

# ═══════════════════════════════════════════════════════════ TUNING
story.append(Paragraph("Tuning: what to touch, what to leave", H1))
story.append(Paragraph(
    "Everything lives in <font face='Courier' size='9'>tradingbot/config.py</font>. Change one thing at "
    "a time, re-run the seed sweep, and keep the change only if it holds across <i>most</i> seeds — "
    "not just the one you looked at.", Body))

story.append(table([
    ["Setting", "Now", "Effect if raised", "Verdict"],
    ["risk_per_trade_pct", "2%", "Bigger positions, proportionally bigger drawdowns",
     Paragraph("<font color='#B45309'><b>Main dial</b></font><br/>Lower to 1% to halve risk", Cell)],
    ["atr_init_mult", "2.5×", "Wider stops: fewer whipsaws, smaller size, bigger single losses",
     Paragraph("Reasonable range<br/>2.0–3.0", Cell)],
    ["atr_trail_mult", "3.0×", "Looser trail: rides trends longer, gives back more at the top",
     Paragraph("Reasonable range<br/>2.5–3.5", Cell)],
    ["max_positions", "4", "More concurrent positions, more correlated exposure",
     Paragraph("Leave at 4<br/>(one per symbol)", Cell)],
    ["daily_dd_limit", "3%", "Looser breaker — more rope before the halt",
     Paragraph("<font color='#B3261E'><b>Do not raise</b></font>", Cell)],
    ["weekly_dd_limit", "5%", "Looser breaker — more rope before the halt",
     Paragraph("<font color='#B3261E'><b>Do not raise</b></font>", Cell)],
], [1.35 * inch, 0.45 * inch, 2.85 * inch, 2.25 * inch]))

story.append(Paragraph("The overfitting trap — learn this before you tune anything", H2))
story.append(Paragraph(
    "In Round 7 a parameter sweep found settings that beat the defaults on test market 42: Sharpe 0.96 "
    "versus 0.60. Genuinely tempting. But re-tested across 15 <i>different</i> markets, those 'optimal' "
    "settings won only 5 times while the plain defaults won 10. The improvement was <b>noise fitted to "
    "one dataset</b>, and shipping it would have made the system worse.", Body))
story.append(Paragraph(
    "This is overfitting, and it is the single most common way backtested systems fail in live trading. "
    "It is also the reason to distrust any result — <i>including every number in this document</i> — that "
    "has not been reproduced on data it was never tuned against.", Body))

story.append(callout(
    "The rule that keeps you honest",
    "If a change only helps on the market you tested it on, <b>it is noise and you must discard it</b>. "
    "Validate across many seeds, or do not ship it.",
    ACCENT, BAND))
story.append(Spacer(1, 10))

story.append(Paragraph("Re-testing a change", H3))
story.append(Table([[Paragraph(
    "# after editing config.py — check it across many markets<br/>"
    "python scripts/run_extended_reps.py     <font color='#5B6672'># 20-seed sweep</font><br/>"
    "python scripts/run_bot_tournament.py    <font color='#5B6672'># all bots head-to-head</font><br/>"
    "python -m pytest tests/ -q              <font color='#5B6672'># risk controls still sound</font>", Mono)]],
    colWidths=[6.9 * inch], style=TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#F5F7FA")),
        ("BOX", (0, 0), (-1, -1), 0.5, RULE),
        ("LEFTPADDING", (0, 0), (-1, -1), 10), ("RIGHTPADDING", (0, 0), (-1, -1), 10),
        ("TOPPADDING", (0, 0), (-1, -1), 9), ("BOTTOMPADDING", (0, 0), (-1, -1), 9),
    ])))
story.append(Spacer(1, 8))
story.append(Paragraph(
    "Keep the change only if median return holds or improves, the share of profitable seeds does not "
    "fall, and worst-case weekly drawdown stays under 5%. <b>All three.</b>", Body))

story.append(PageBreak())

# ═══════════════════════════════════════════════════════ STAGE 3 GATE
story.append(Paragraph("When to move to real money", H1))
story.append(Paragraph(
    "You are at <b>Stage 2</b>: Alpaca paper trading, real prices, simulated money. Stage 3 is Robinhood "
    "with real dollars. The gap between them is not technical — the code is written and tested. "
    "It is entirely about whether you have <b>evidence</b> and whether you can absorb the loss.", Body))

story.append(Spacer(1, 3))
story.append(callout(
    "Robinhood has no paper mode",
    "Unlike Alpaca, Robinhood crypto has no simulated account. Every order is real. There is no undo. "
    "That is why the broker <b>refuses to start</b> unless you set a secret literally spelling out that you "
    "understand this. Deleting that one secret is your instant kill switch.",
    STOP, colors.HexColor("#FEF2F2")))
story.append(Spacer(1, 12))

story.append(Paragraph("Every box must be checked", H2))
story.append(table([
    ["", "Gate", "Why it matters"],
    ["1", Paragraph("<b>90+ days of paper trading</b>", Cell),
     "Two or three weeks of calm proves nothing. You need enough time for an ugly stretch to occur."],
    ["2", Paragraph("<b>You have watched a real drawdown</b>", Cell),
     "You must know how <i>you</i> react to a 5% week — while it costs nothing. If paper losses "
     "already bother you, real ones will drive bad decisions."],
    ["3", Paragraph("<b>A circuit breaker has fired</b>", Cell),
     "Confirm with your own eyes that it flattened positions and blocked re-entry. Do not take this "
     "on trust from a backtest."],
    ["4", Paragraph("<b>Paper results are in the expected range</b>", Cell),
     "Roughly flat to modestly positive. Wildly better than backtest is a warning sign, not a green light."],
    ["5", Paragraph("<b>You can lose the entire amount</b>", Cell),
     "Not \"would rather not.\" Would not change a single thing about your life. If that number is $0 "
     "right now, that is a legitimate answer — stay on paper."],
    ["6", Paragraph("<b>You can explain every alert</b>", Cell),
     "Why it entered, why it exited, what −1.00R means. Running a system you cannot read is gambling "
     "with extra steps."],
], [0.3 * inch, 1.85 * inch, 4.75 * inch]))

story.append(Paragraph("If you do proceed", H2))
bullets([
    "<b>Fund a dedicated sub-account only.</b> Never your main portfolio. Robinhood's agentic account "
    "exists for exactly this.",
    "<b>Start at the smallest amount that still feels real</b> — enough that you pay attention, "
    "little enough that losing all of it changes nothing.",
    "<b>Set <font face='Courier' size='8.5'>--starting-equity</font> to match what you actually funded</b>, "
    "so the bot never sizes against money you did not intend to expose.",
    "<b>Halve the risk for the first month:</b> <font face='Courier' size='8.5'>risk_per_trade_pct = 0.01</font>. "
    "You are buying information about live slippage, not chasing returns.",
    "<b>Re-read the kill switches before you start</b>, not during your first bad week.",
])

story.append(KeepTogether([
    Paragraph("Kill switches", H2),
    table([
        ["To do this", "Do this", "Effect"],
        ["Stop real-money trading instantly",
         Paragraph("Delete the <font face='Courier' size='8'>ROBINHOOD_LIVE_ACK</font> secret", Cell),
         "Next run fails loudly rather than trading"],
        ["Fall back to paper",
         Paragraph("Set <font face='Courier' size='8'>TRADING_BROKER</font> = <font face='Courier' size='8'>alpaca-paper</font>", Cell),
         "Simulated money again"],
        ["Stop everything",
         "Actions &gt; tradingbot-daily &gt; ... &gt; Disable workflow",
         "No further runs at all"],
    ], [2.0 * inch, 2.75 * inch, 2.15 * inch]),
    Spacer(1, 6),
    Paragraph(
        "<b>Disabling the workflow does not close open positions.</b> If you are holding and want out, "
        "sell manually in the Robinhood app.", Body),
]))

story.append(Spacer(1, 10))
story.append(callout(
    "The honest summary",
    "Median expectation is roughly <b>+8% over two years</b> on synthetic data, with 2 of 20 tested markets "
    "losing money. Real trading adds slippage, spreads, and gap risk that backtests understate, so expect "
    "<i>worse</i> than these figures rather than better. The circuit breakers bound how fast you can lose, "
    "<b>not whether you lose</b> — 3% a day still compounds badly across a bad month. Position sizing is the "
    "real protection; the breakers are only the backstop. This is a considered experiment with capital you "
    "can afford to lose, not an income stream.",
    INK, BAND))


# ═══════════════════════════════════════════════════════════ CHROME
def _footer(canvas, doc, label):
    canvas.saveState()
    canvas.setStrokeColor(RULE)
    canvas.setLineWidth(0.5)
    canvas.line(0.8 * inch, 0.62 * inch, LETTER[0] - 0.8 * inch, 0.62 * inch)
    canvas.setFont("Helvetica", 7.5)
    canvas.setFillColor(MUTED)
    canvas.drawString(0.8 * inch, 0.45 * inch, label)
    canvas.drawRightString(LETTER[0] - 0.8 * inch, 0.45 * inch, f"Page {doc.page}")
    canvas.restoreState()


def cover_page(canvas, doc):
    canvas.saveState()
    canvas.setFillColor(ACCENT)
    canvas.rect(0, LETTER[1] - 0.34 * inch, LETTER[0], 0.34 * inch, stroke=0, fill=1)
    canvas.restoreState()
    _footer(canvas, doc, "Trading bot handout  ·  research system, synthetic data  ·  not financial advice")


def body_page(canvas, doc):
    _footer(canvas, doc, "Trading bot handout  ·  research system, synthetic data  ·  not financial advice")


frame = Frame(0.8 * inch, 0.78 * inch, LETTER[0] - 1.6 * inch, LETTER[1] - 1.55 * inch, id="f")
doc = BaseDocTemplate(
    OUT, pagesize=LETTER,
    leftMargin=0.8 * inch, rightMargin=0.8 * inch,
    topMargin=0.75 * inch, bottomMargin=0.78 * inch,
    title="How the Bots Work — Automated Crypto Trading System",
    author="tradingbot", subject="Design rationale, evidence, tuning, and go-live criteria",
)
doc.addPageTemplates([
    PageTemplate(id="cover", frames=[frame], onPage=cover_page),
    PageTemplate(id="body", frames=[frame], onPage=body_page),
])
doc.build(story)
print(f"wrote {OUT}")
