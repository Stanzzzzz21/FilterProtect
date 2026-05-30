// ---------- Render Port Fix ----------
const express = require("express");
const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (_req, res) => res.send("FilterProtect is running."));
app.listen(PORT, () => console.log(`Web server running on port ${PORT}`));

// ---------- Imports ----------
require("dotenv").config();
const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  PermissionsBitField,
  Events,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle
} = require("discord.js");
const fs = require("fs");

const GEMINI_API_KEY = process.env.GEMINI_API_KEY; // set in Render
const CONFIG_FILE = "./filterprotect_config.json";

// ---------- Config ----------
let config = { guilds: {} };

if (fs.existsSync(CONFIG_FILE)) {
  try {
    config = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    config = { guilds: {} };
  }
}

function saveConfig() {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

function ensureGuildConfig(guildId) {
  if (!config.guilds[guildId]) {
    config.guilds[guildId] = {
      harshness: 2,
      logsChannelId: null,
      adminRoleId: null,
      strikes: {}
    };
  }
  return config.guilds[guildId];
}

// ---------- Client ----------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ],
  partials: [Partials.Channel, Partials.Message, Partials.GuildMember]
});

// ---------- Utils ----------
function isOwnerOrAdmin(member) {
  if (!member || !member.guild) return false;
  if (member.id === member.guild.ownerId) return true;
  return member.permissions.has(PermissionsBitField.Flags.Administrator);
}

async function logEvent(guild, guildConfig, title, description, fields = []) {
  try {
    let channel = guildConfig.logsChannelId
      ? guild.channels.cache.get(guildConfig.logsChannelId)
      : null;

    if (!channel) {
      channel = guild.channels.cache.find(
        c => c.name === "filterprotect-logs" && c.isTextBased()
      );
      if (!channel) {
        channel = await guild.channels.create({
          name: "filterprotect-logs",
          type: 0
        });
      }
      guildConfig.logsChannelId = channel.id;
      saveConfig();
    }

    const embed = new EmbedBuilder()
      .setTitle(title)
      .setDescription(description)
      .setColor("#ff5555")
      .setTimestamp();

    if (fields.length) embed.addFields(fields);

    await channel.send({ embeds: [embed] });
  } catch (e) {
    console.error("Log error:", e);
  }
}

// ---------- Gemini Moderation ----------
async function geminiModerate(text, urls = []) {
  if (!GEMINI_API_KEY) {
    console.warn("No GEMINI_API_KEY set.");
    return { unsafe: false, reason: "No API key" };
  }

  const prompt = `
You are an advanced moderation AI for a Discord server.

Analyze the following message and attached URLs (which may be images, videos, or external links).

Classify for:
- sexual content (including minors, grooming)
- nudity
- violence / gore
- hate / harassment / slurs
- self-harm / suicide
- extremism / terrorism
- scams / fraud / malware
- drugs / weapons
- highly explicit memes or content

Return ONLY a compact JSON object like:
{
  "unsafe": true,
  "severity": 1-4,
  "categories": ["sexual", "violence"],
  "reason": "short human-readable summary"
}

Where:
- unsafe = true if the message should be blocked
- severity:
  1 = mild (warning)
  2 = medium (strike)
  3 = high (timeout)
  4 = extreme (kick/ban level)
- categories = list of tags
- reason = short explanation

Message text:
${text || "[no text]"}

Attached URLs:
${urls.length ? urls.join("\n") : "[none]"}
`;

  try {
    const res = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=" +
        GEMINI_API_KEY,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [{ text: prompt }]
            }
          ]
        })
      }
    );

    const data = await res.json();
    const textResp =
      data?.candidates?.[0]?.content?.parts?.[0]?.text ||
      '{"unsafe":false,"severity":1,"categories":[],"reason":"no response"}';

    let parsed;
    try {
      parsed = JSON.parse(textResp);
    } catch {
      parsed = {
        unsafe: false,
        severity: 1,
        categories: [],
        reason: "parse error: " + textResp.slice(0, 120)
      };
    }

    return {
      unsafe: !!parsed.unsafe,
      severity: Number(parsed.severity) || 1,
      categories: Array.isArray(parsed.categories) ? parsed.categories : [],
      reason: parsed.reason || "no reason"
    };
  } catch (e) {
    console.error("Gemini error:", e);
    return { unsafe: false, severity: 1, categories: [], reason: "Gemini error" };
  }
}

// ---------- Setup Sessions (Buttons) ----------
const setupSessions = new Map(); // key: userId

client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user.tag}`);

  const commands = [
    {
      name: "setup",
      description: "Run FilterProtect setup (server owner / admins only)"
    }
  ];

  await client.application.commands.set(commands);
  console.log("Slash commands registered.");
});

// ---------- /setup ----------
client.on(Events.InteractionCreate, async interaction => {
  if (interaction.isChatInputCommand()) {
    if (interaction.commandName === "setup") {
      if (!interaction.inGuild()) {
        return interaction.reply({
          content: "❌ Setup must be run inside a server.",
          ephemeral: true
        });
      }

      if (!isOwnerOrAdmin(interaction.member)) {
        return interaction.reply({
          content: "❌ Only the **server owner** or members with **Administrator** can run `/setup`.",
          ephemeral: true
        });
      }

      const guildId = interaction.guild.id;
      ensureGuildConfig(guildId);

      setupSessions.set(interaction.user.id, {
        guildId,
        step: 1,
        harshness: 2,
        createAdmin: true,
        createLogs: true
      });

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("fp_setup_next")
          .setLabel("Next ➜")
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId("fp_setup_cancel")
          .setLabel("Cancel")
          .setStyle(ButtonStyle.Danger)
      );

      await interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle("🛡️ FilterProtect Setup — Step 1/3")
            .setDescription(
              "Welcome to **FilterProtect**.\n\n" +
                "This wizard will:\n" +
                "• Create a `FilterProtect Admin` role\n" +
                "• Create a `filterprotect-logs` channel\n" +
                "• Let you choose **harshness**\n\n" +
                "Click **Next** to continue."
            )
            .setColor("#5865F2")
        ],
        components: [row],
        ephemeral: true
      });
    }
  }

  if (!interaction.isButton()) return;

  const id = interaction.customId;
  const session = setupSessions.get(interaction.user.id);
  if (!session) return;

  const guild = client.guilds.cache.get(session.guildId);
  if (!guild) {
    setupSessions.delete(interaction.user.id);
    return interaction.update({
      content: "❌ Guild not found. Setup cancelled.",
      embeds: [],
      components: []
    });
  }

  const guildConfig = ensureGuildConfig(guild.id);

  // cancel
  if (id === "fp_setup_cancel") {
    setupSessions.delete(interaction.user.id);
    return interaction.update({
      content: "❌ Setup cancelled.",
      embeds: [],
      components: []
    });
  }

  // navigation
  if (id === "fp_setup_prev") {
    session.step = Math.max(1, session.step - 1);
  } else if (id === "fp_setup_next") {
    session.step = Math.min(3, session.step + 1);
  }

  // harshness buttons
  if (id.startsWith("fp_setup_harsh_")) {
    const level = Number(id.split("_").pop());
    if ([1, 2, 3, 4].includes(level)) {
      session.harshness = level;
    }
  }

  // toggle admin/logs
  if (id === "fp_setup_toggle_admin") {
    session.createAdmin = !session.createAdmin;
  }
  if (id === "fp_setup_toggle_logs") {
    session.createLogs = !session.createLogs;
  }

  // finish
  if (id === "fp_setup_finish") {
    guildConfig.harshness = session.harshness;

    // create admin role
    if (session.createAdmin) {
      let role = guild.roles.cache.find(r => r.name === "FilterProtect Admin");
      if (!role) {
        role = await guild.roles.create({
          name: "FilterProtect Admin",
          permissions: [PermissionsBitField.Flags.ManageMessages]
        });
      }
      guildConfig.adminRoleId = role.id;
    }

    // create logs channel
    if (session.createLogs) {
      let ch = guild.channels.cache.find(
        c => c.name === "filterprotect-logs" && c.isTextBased()
      );
      if (!ch) {
        ch = await guild.channels.create({
          name: "filterprotect-logs",
          type: 0
        });
      }
      guildConfig.logsChannelId = ch.id;
    }

    saveConfig();
    setupSessions.delete(interaction.user.id);

    await interaction.update({
      embeds: [
        new EmbedBuilder()
          .setTitle("✅ FilterProtect Setup Complete")
          .setDescription(
            `Harshness: **${guildConfig.harshness}**\n` +
              `Admin role: ${
                guildConfig.adminRoleId ? `<@&${guildConfig.adminRoleId}>` : "Not created"
              }\n` +
              `Logs channel: ${
                guildConfig.logsChannelId ? `<#${guildConfig.logsChannelId}>` : "Not created"
              }\n\n` +
              "FilterProtect is now active and using **Gemini** to scan every message, link, image, and attachment."
          )
          .setColor("#57F287")
      ],
      components: []
    });

    await logEvent(
      guild,
      guildConfig,
      "✅ FilterProtect Setup Complete",
      `Setup finished by ${interaction.user.tag}.`
    );

    return;
  }

  // re-render current step
  const step = session.step;
  let embed;
  let components = [];

  if (step === 1) {
    embed = new EmbedBuilder()
      .setTitle("🛡️ FilterProtect Setup — Step 1/3")
      .setDescription(
        "Welcome to **FilterProtect**.\n\n" +
          "This wizard will:\n" +
          "• Create a `FilterProtect Admin` role\n" +
          "• Create a `filterprotect-logs` channel\n" +
          "• Let you choose **harshness**\n\n" +
          "Click **Next** to continue."
      )
      .setColor("#5865F2");

    components = [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("fp_setup_next")
          .setLabel("Next ➜")
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId("fp_setup_cancel")
          .setLabel("Cancel")
          .setStyle(ButtonStyle.Danger)
      )
    ];
  } else if (step === 2) {
    embed = new EmbedBuilder()
      .setTitle("🛡️ FilterProtect Setup — Step 2/3 (Harshness)")
      .setDescription(
        "Choose a **harshness level**:\n\n" +
          "1 = Soft (delete + warn)\n" +
          "2 = Medium (delete + warn + strike)\n" +
          "3 = Hard (delete + timeout)\n" +
          "4 = Extreme (delete + timeout + auto‑kick at 3 strikes)\n\n" +
          `Current selection: **${session.harshness}**`
      )
      .setColor("#FEE75C");

    components = [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("fp_setup_harsh_1")
          .setLabel("1")
          .setStyle(session.harshness === 1 ? ButtonStyle.Success : ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId("fp_setup_harsh_2")
          .setLabel("2")
          .setStyle(session.harshness === 2 ? ButtonStyle.Success : ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId("fp_setup_harsh_3")
          .setLabel("3")
          .setStyle(session.harshness === 3 ? ButtonStyle.Success : ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId("fp_setup_harsh_4")
          .setLabel("4")
          .setStyle(session.harshness === 4 ? ButtonStyle.Success : ButtonStyle.Secondary)
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("fp_setup_prev")
          .setLabel("⬅ Previous")
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId("fp_setup_next")
          .setLabel("Next ➜")
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId("fp_setup_cancel")
          .setLabel("Cancel")
          .setStyle(ButtonStyle.Danger)
      )
    ];
  } else if (step === 3) {
    embed = new EmbedBuilder()
      .setTitle("🛡️ FilterProtect Setup — Step 3/3 (Roles & Logs)")
      .setDescription(
        "Choose what FilterProtect should create:\n\n" +
          `Admin role: **${session.createAdmin ? "Create `FilterProtect Admin`" : "Do not create"}**\n` +
          `Logs channel: **${
            session.createLogs ? "Create `filterprotect-logs`" : "Do not create"
          }**\n\n` +
          "Click **Finish** to apply settings."
      )
      .setColor("#57F287");

    components = [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("fp_setup_toggle_admin")
          .setLabel(
            session.createAdmin ? "Disable Admin Role Creation" : "Enable Admin Role Creation"
          )
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId("fp_setup_toggle_logs")
          .setLabel(
            session.createLogs ? "Disable Logs Channel Creation" : "Enable Logs Channel Creation"
          )
          .setStyle(ButtonStyle.Secondary)
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("fp_setup_prev")
          .setLabel("⬅ Previous")
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId("fp_setup_finish")
          .setLabel("Finish ✅")
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId("fp_setup_cancel")
          .setLabel("Cancel")
          .setStyle(ButtonStyle.Danger)
      )
    ];
  }

  await interaction.update({ embeds: [embed], components });
});

// ---------- Moderation ----------
client.on("messageCreate", async message => {
  if (!message.guild || message.author.bot) return;

  const guildId = message.guild.id;
  const guildConfig = ensureGuildConfig(guildId);

  const text = message.content || "";
  const urls = [];

  // attachments (images, videos, files)
  for (const att of message.attachments.values()) {
    if (att.url) urls.push(att.url);
  }

  // links in text
  const linkRegex = /(https?:\/\/[^\s]+)/gi;
  let match;
  while ((match = linkRegex.exec(text)) !== null) {
    urls.push(match[1]);
  }

  const result = await geminiModerate(text, urls);
  if (!result.unsafe) return;

  async function punish(reason, severity) {
    try {
      await message.delete().catch(() => {});

      await message.channel
        .send({
          content: `⚠️ ${message.author}, your message was removed: **${reason}**`
        })
        .then(m => setTimeout(() => m.delete().catch(() => {}), 7000));

      const harsh = guildConfig.harshness;

      // strikes
      if (harsh >= 2 || severity >= 2) {
        if (!guildConfig.strikes[message.author.id]) guildConfig.strikes[message.author.id] = 0;
        guildConfig.strikes[message.author.id]++;
        saveConfig();
      }

      // timeout
      if (harsh >= 3 || severity >= 3) {
        try {
          await message.member.timeout(10 * 60 * 1000, "FilterProtect auto-timeout (Gemini)");
        } catch {}
      }

      // kick on 3 strikes at harsh 4 or severity 4
      if (harsh === 4 || severity === 4) {
        const strikes = guildConfig.strikes[message.author.id] || 0;
        if (strikes >= 3) {
          try {
            await message.member.kick("FilterProtect auto-kick (3 strikes, Gemini)");
          } catch {}
        }
      }

      await logEvent(
        message.guild,
        guildConfig,
        "🚨 FilterProtect Action (Gemini)",
        `Gemini flagged content as unsafe.\nReason: **${reason}**`,
        [
          { name: "User", value: `${message.author.tag} (${message.author.id})`, inline: true },
          { name: "Channel", value: `${message.channel}`, inline: true },
          {
            name: "Severity",
            value: `${severity} (1=low, 4=extreme)`,
            inline: true
          },
          {
            name: "Categories",
            value: result.categories.length ? result.categories.join(", ") : "[none]",
            inline: false
          },
          { name: "Content", value: text || "[no text]", inline: false },
          { name: "URLs", value: urls.join("\n") || "[none]", inline: false }
        ]
      );
    } catch (e) {
      console.error("Punish error:", e);
    }
  }

  await punish(result.reason || "Inappropriate content", result.severity || 1);
});

// ---------- Guild Join ----------
client.on(Events.GuildCreate, async guild => {
  ensureGuildConfig(guild.id);
  saveConfig();

  const channel = guild.systemChannel || guild.channels.cache.find(c => c.isTextBased());
  if (!channel) return;

  const embed = new EmbedBuilder()
    .setTitle("👋 Welcome to FilterProtect (Gemini)")
    .setDescription(
      "Thanks for adding **FilterProtect**.\n\n" +
        "Use `/setup` (server owner / admins) to configure harshness and logging.\n" +
        "All messages, links, images, and attachments are scanned by **Gemini**."
    )
    .setColor("#5865F2");

  await channel.send({ embeds: [embed] });
});

// ---------- Login ----------
console.log("Starting FilterProtect...");
console.log("DISCORD_TOKEN present:", !!process.env.DISCORD_TOKEN);
client.login(process.env.DISCORD_TOKEN);
