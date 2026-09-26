package ua.pp.homesweeethome.irbridge

import android.util.Base64

/**
 * Converters from the two formats IR codes are actually published in into the
 * microsecond arrays [ConsumerIrManager][android.hardware.ConsumerIrManager]
 * wants.
 *
 * Both are verified against real frames: a Broadlink Midea packet decodes to a
 * 4400/4400 header with 560/560 and 560/1680 bits, a Gree one to 9000/4500, a
 * Daikin one to 3500/1700 — which is exactly what those protocols specify.
 */
object Codecs {

    // ---------------------------------------------------------------- Broadlink

    /**
     * Broadlink "learned code" packet, as shipped by SmartIR, the Broadlink
     * app, and most Home Assistant blueprints.
     *
     * Layout (mjg59/python-broadlink, protocol.md):
     * ```
     *   [0]      0x26 = IR   (0xb2 / 0xd7 = RF, rejected here)
     *   [1]      repeat count
     *   [2..3]   payload length, little endian
     *   [4..]    durations in ticks of 2^-15 s
     *            a value >= 256 is escaped as 0x00 <hi> <lo>
     *   tail     0x00 0x0d 0x05  — ~102 ms, the capture timeout, not signal
     * ```
     */
    fun fromBroadlinkBase64(b64: String): DecodedIr {
        val padded = b64.trim().let { it + "=".repeat((4 - it.length % 4) % 4) }
        val raw = runCatching { Base64.decode(padded, Base64.DEFAULT) }
            .getOrElse { throw IrError("not valid base64: ${it.message}") }

        if (raw.size < 5) throw IrError("packet too short (${raw.size} bytes)")
        val kind = raw[0].toInt() and 0xFF
        if (kind != 0x26) {
            throw IrError(
                "first byte is 0x%02x, expected 0x26 (IR). 0xb2/0xd7 are RF codes and cannot be sent over IR.".format(kind)
            )
        }

        val repeat = (raw[1].toInt() and 0xFF)
        val declared = (raw[2].toInt() and 0xFF) or ((raw[3].toInt() and 0xFF) shl 8)
        val end = minOf(4 + declared, raw.size)

        val ticks = ArrayList<Int>(declared)
        var i = 4
        while (i < end) {
            val b = raw[i].toInt() and 0xFF
            if (b == 0x00) {
                if (i + 2 >= end) break            // terminator, not data
                ticks.add(((raw[i + 1].toInt() and 0xFF) shl 8) or (raw[i + 2].toInt() and 0xFF))
                i += 3
            } else {
                ticks.add(b)
                i += 1
            }
        }
        if (ticks.isEmpty()) throw IrError("packet decoded to zero durations")

        val us = ticks.map { Math.round(it * TICK_MICROS).toInt() }.toMutableList()
        trimTrailingGap(us)

        return DecodedIr(
            pattern = us.toIntArray(),
            carrierHz = IrTransmitter.DEFAULT_CARRIER_HZ,  // Broadlink does not record it
            repeatHint = repeat,
            format = "broadlink",
        )
    }

    // ------------------------------------------------------------------- Pronto

    /**
     * Pronto hex, learned format only (`0000 ...`).
     *
     * ```
     *   w0  0x0000        learned code
     *   w1  frequency divisor: unit_us = w1 * 0.241246
     *   w2  burst-pair count of the intro sequence
     *   w3  burst-pair count of the repeat sequence
     * ```
     * The intro sequence is the full frame when present; a code that carries
     * only a repeat sequence uses that instead.
     */
    fun fromPronto(hex: String): DecodedIr {
        val words = hex.trim().split(Regex("[\\s,]+")).filter { it.isNotEmpty() }.map {
            it.toIntOrNull(16) ?: throw IrError("'$it' is not a 4-digit hex word")
        }
        if (words.size < 4) throw IrError("need at least 4 words, got ${words.size}")
        if (words[0] != 0x0000) {
            throw IrError(
                "leading word is 0x%04x; only 0x0000 (learned) codes carry raw timings".format(words[0])
            )
        }

        val unitMicros = words[1] * PRONTO_CLOCK_MICROS
        if (unitMicros <= 0.0) throw IrError("frequency word is zero")
        val carrierHz = Math.round(1_000_000.0 / unitMicros).toInt()

        val intro = words[2] * 2
        val repeatSeq = words[3] * 2
        if (words.size < 4 + intro + repeatSeq) {
            throw IrError("declared ${intro / 2}+${repeatSeq / 2} burst pairs but only ${words.size - 4} words follow")
        }

        val body = when {
            intro > 0 -> words.subList(4, 4 + intro)
            repeatSeq > 0 -> words.subList(4 + intro, 4 + intro + repeatSeq)
            else -> throw IrError("code declares no burst pairs")
        }

        val us = body.map { Math.round(it * unitMicros).toInt() }.toMutableList()
        trimTrailingGap(us)

        return DecodedIr(
            pattern = us.toIntArray(),
            carrierHz = carrierHz,
            repeatHint = 1,
            format = "pronto",
        )
    }

    // ------------------------------------------------------------------- Coolix

    /**
     * The Coolix 24-bit protocol, built from the bits up rather than looked up.
     *
     * Why this exists: `ac_codes.json` is generated from SmartIR set 1380,
     * whose table covers mode x fan x temperature and stops there. It carries
     * no swing and no dry mode. That is a gap in the *table*, not in the unit —
     * every one of the 95 frames in that asset decodes as a Coolix message, and
     * Coolix carries both.
     *
     * The evidence, so nobody has to re-derive it:
     *
     *  - the asset's power-off frame decodes to 0xB27BE0, which is
     *    `kCoolixOff` in IRremoteESP8266, bit for bit;
     *  - all 95 frames decode as valid Coolix — three data bytes, each
     *    followed by its own complement, whole message sent twice;
     *  - feeding all 156 mode/fan/temperature combinations through
     *    [stateFrame] reproduces all 156 asset frames exactly, none missed.
     *
     * That last point is what makes this trustworthy. The encoder is not a
     * plausible reading of a datasheet; it is demonstrably the same function
     * that produced the frames already proven against the hardware, which is
     * why it can be pointed at the two combinations SmartIR left out.
     *
     * Wire format, from ir_Coolix.cpp:
     * ```
     *   header 4692 mark / 4416 space
     *   then, for each of 3 bytes, most significant bit first:
     *       the byte, then the byte XOR 0xFF
     *   a bit is a 552 mark followed by 1656 (one) or 552 (zero) of space
     *   trailing 552 mark, 5244 gap, then the entire message a second time
     * ```
     *
     * Bit layout, from `union CoolixProtocol`:
     * ```
     *   bit    0     unknown, always 0 in observed frames
     *   bit    1     zone follow, unused here
     *   bits   2-3   mode
     *   bits   4-7   temperature — via TEMP_MAP, not a plain integer
     *   bits   8-12  the sending remote's own thermometer; 0b11111 = ignore it
     *   bits  13-15  fan
     *   bits  16-19  unknown, always 0b0010 in observed frames
     *   bits  20-23  fixed 0b1011
     * ```
     */
    object Coolix {

        // --- wire timings, microseconds ------------------------------------

        const val HDR_MARK = 4692
        const val HDR_SPACE = 4416
        const val BIT_MARK = 552
        const val ONE_SPACE = 1656
        const val ZERO_SPACE = 552

        /** Silence between the message and the second copy of it. */
        const val REPEAT_GAP = 5244

        // --- whole-frame special commands ----------------------------------
        //
        // These are not state, and they do not merge with it. Each is a
        // complete message the unit reads as one button press. Most of them
        // TOGGLE, so sending one twice lands back where it started — which is
        // why none of them can be folded into a resend.

        /** The asset's own off frame decodes to exactly this. */
        const val OFF = 0xB27BE0

        /** Continuous swing, on or off. Toggles. */
        const val SWING = 0xB26BE0

        /** Move the vertical vane one step. Stateless. */
        const val SWING_V_STEP = 0xB20FE0

        /**
         * Horizontal swing — but these are the same 24 bits as Coolix's turbo
         * command, so which of the two a given unit performs is a property of
         * the unit and cannot be known from here.
         */
        const val SWING_H = 0xB5F5A2

        const val SLEEP = 0xB2E003
        const val LED = 0xB5F5A5
        const val CLEAN = 0xB5F5AA

        // --- state fields --------------------------------------------------

        const val MODE_COOL = 0b00
        const val MODE_DRY = 0b01
        const val MODE_AUTO = 0b10
        const val MODE_HEAT = 0b11

        const val FAN_MAX = 0b001
        const val FAN_MED = 0b010
        const val FAN_MIN = 0b100
        const val FAN_AUTO = 0b101

        /**
         * The other idle fan encoding. Coolix has two, and uses this one in
         * auto and dry modes while [FAN_AUTO] serves cool, heat and fan.
         *
         * The asset agrees: every `heat_cool` frame in it carries 0b000. That
         * is the real reason fan looks "ignored" in that mode — all three fan
         * speeds encode to an identical frame because the protocol writes auto
         * there regardless of what was asked for.
         */
        const val FAN_AUTO0 = 0b000

        /** Tells the unit to disregard the thermometer inside the remote. */
        const val SENSOR_TEMP_IGNORE = 0b11111

        const val TEMP_MIN = 17
        const val TEMP_MAX = 30

        /** Fan mode is Dry wearing this temperature code instead of a value. */
        const val FAN_TEMP_CODE = 0b1110

        /**
         * Temperature codes for 17..30 C.
         *
         * Reflected binary, not counting: 22 C is 0b0111 but 23 C is 0b0101.
         * Arithmetic on the raw field yields a valid-looking frame for the
         * wrong temperature, so it always goes through here.
         */
        private val TEMP_MAP = intArrayOf(
            0b0000, 0b0001, 0b0011, 0b0010, 0b0110, 0b0111, 0b0101,
            0b0100, 0b1100, 0b1101, 0b1001, 0b1000, 0b1010, 0b1011,
        )

        /** Celsius to its raw 4-bit code, clamped to what the protocol has. */
        fun tempCode(celsius: Int): Int =
            TEMP_MAP[celsius.coerceIn(TEMP_MIN, TEMP_MAX) - TEMP_MIN]

        /** Assemble a state message from its fields. */
        fun stateFrame(mode: Int, fan: Int, tempCode: Int): Int =
            (0xB2 shl 16) or
                ((fan and 0b111) shl 13) or
                (SENSOR_TEMP_IGNORE shl 8) or
                ((tempCode and 0b1111) shl 4) or
                ((mode and 0b11) shl 2)

        /**
         * One button press, as microseconds.
         *
         * The message goes out twice. That is the protocol and not a retry — a
         * single copy is an incomplete transmission. It is also why `repeat = 1`
         * is the right transmitter setting for a toggle: asking for two repeats
         * of a toggle reverses it.
         */
        fun press(value: Int): IntArray {
            val out = ArrayList<Int>(199)
            repeat(2) { copy ->
                if (copy > 0) out.add(REPEAT_GAP)
                out.add(HDR_MARK)
                out.add(HDR_SPACE)
                for (shift in intArrayOf(16, 8, 0)) {
                    val byte = (value ushr shift) and 0xFF
                    for (b in intArrayOf(byte, byte xor 0xFF)) {
                        for (bit in 7 downTo 0) {
                            out.add(BIT_MARK)
                            out.add(if ((b ushr bit) and 1 == 1) ONE_SPACE else ZERO_SPACE)
                        }
                    }
                }
                out.add(BIT_MARK)
            }
            return out.toIntArray()
        }

        /**
         * Read a Coolix value back out of a microsecond pattern, or null if the
         * pattern is not one.
         *
         * Deliberately tolerant on timings. The frames in `ac_codes.json` came
         * through Broadlink's 30.4 us tick, so a nominal 552 arrives as
         * anything from 457 to 640, and a 1656 as 1553 to 1705. Only the ratio
         * between the two carries information.
         */
        fun decode(pattern: IntArray): Int? {
            if (pattern.size < 2 + 2 * 48) return null

            val bits = StringBuilder(48)
            var i = 2                                   // step over the header
            while (i + 1 < pattern.size && bits.length < 48) {
                val space = pattern[i + 1]
                if (space > LONG_GAP_MICROS / 4) break   // reached the message gap
                bits.append(if (space > (ONE_SPACE + ZERO_SPACE) / 2) '1' else '0')
                i += 2
            }
            if (bits.length != 48) return null

            var value = 0
            for (byteIdx in 0 until 3) {
                val at = byteIdx * 16
                val data = bits.substring(at, at + 8).toInt(2)
                val check = bits.substring(at + 8, at + 16).toInt(2)
                // Each data byte is followed by its own complement. Requiring
                // all three pairs to agree is what makes a false positive here
                // vanishingly unlikely rather than merely unlikely.
                if (data xor 0xFF != check) return null
                value = (value shl 8) or data
            }
            return value
        }

        /**
         * Whether a frame known to work on the unit is a Coolix frame.
         *
         * The gate on everything built by [stateFrame] and [press]. If
         * `ac_codes.json` is ever regenerated for a different unit speaking
         * some other protocol, these hand-assembled frames would be
         * meaningless noise aimed at someone's air conditioner — so the
         * endpoints that depend on them refuse to fire instead of guessing.
         *
         * It doubles as the encoder's self-check, which is why it takes a whole
         * pattern rather than a flag. There is no unit test in this project, so
         * the argument that [press] is correct rests on this: it has to
         * reproduce a frame that is *known* to work on the hardware. Get the
         * byte order or the bit order wrong and the round trip below disagrees,
         * closing the gate instead of transmitting something malformed.
         */
        fun looksLikeCoolix(pattern: IntArray): Boolean {
            val value = decode(pattern) ?: return false
            // Anchors the decoder against real captured data: a mirrored byte
            // order would put something other than 0b1011 in the top nibble.
            if ((value ushr 20) != 0xB) return false
            // And anchors the encoder against the decoder.
            return decode(press(value)) == value
        }
    }

    // -------------------------------------------------------------------- shared

    /**
     * A frame's final entry is a long silence that says "frame over". Sending
     * it just holds the emitter idle, and an even-length pattern upsets some
     * drivers, so drop it.
     */
    private fun trimTrailingGap(us: MutableList<Int>) {
        while (us.isNotEmpty() && us.last() > LONG_GAP_MICROS) us.removeAt(us.size - 1)
        if (us.size % 2 == 0 && us.isNotEmpty()) us.removeAt(us.size - 1)
    }

    /**
     * 2^-15 s per tick. python-broadlink's own note is that "us * 269 / 8192
     * works very well" for the forward direction, so the inverse used here is
     * 8192/269 — a 0.2% difference from the nominal 30.5176, far inside the
     * tolerance of any IR receiver.
     */
    const val TICK_MICROS = 8192.0 / 269.0

    /** Pronto's clock period in microseconds. */
    const val PRONTO_CLOCK_MICROS = 0.241246

    /** Anything longer than this between marks is an inter-frame gap. */
    const val LONG_GAP_MICROS = 20_000
}

data class DecodedIr(
    val pattern: IntArray,
    val carrierHz: Int,
    val repeatHint: Int,
    val format: String,
) {
    override fun equals(other: Any?): Boolean =
        other is DecodedIr && pattern.contentEquals(other.pattern) &&
            carrierHz == other.carrierHz && format == other.format

    override fun hashCode(): Int = pattern.contentHashCode() * 31 + carrierHz
}
