require("dotenv").config();
const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  PermissionsBitField,
  Events
} = require("discord.js");
const fetch = require("node-fetch");
const fs = require("fs");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ],
  partials: [Partials.Channel, Partials.Message, Partials.GuildMember]
});

const HF_API_KEY = process.env.HF_API_KEY;
const MODEL_URL = "https://api-inference.huggingface.co/models/Falconsai/nsfw_image_detection";

// in‑memory + file config
let config = { guilds: {} };
const CONFIG_FILE = "./filterprotect_config.json";
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

// ultra‑strict image classifier wrapper
async function classifyImage(url) {
  if (!HF_API_KEY) return null;
  try {
    const res = await fetch(MODEL_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${HF_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ inputs: url })
    });
    const data = await res.json();
    if (!Array.isArray(data) || !data[0]) return null;
    const label = (data[0].label || "").toLowerCase();
    return label;
  } catch (e) {
    console.error("HF error:", e);
    return null;
  }
}

// simple word lists (extend as you like)
const WORDS = {
  nsfw: ["sex", "porn", "nude", "boobs", "cock", "pussy", "nudes", "onlyfans"],
  slurs: ["slur1", "slur2", "slur3"],
  violence: ["kill", "stab", "shoot", "blood", "gore", "murder"],
  drugs: ["weed", "cocaine", "heroin", "meth", "pills", "xanax"],
  gambling: ["casino", "betting", "slots", "roulette", "blackjack", "jackpot"],
  scams: ["free nitro", "steam gift", "click here", "verify your account", "airdrop"],
  selfharm: ["kys", "kill yourself", "go die", "end yourself"],
  grooming: ["send pics", "dont tell anyone", "dont tell your parents", "how old are you really"]
};

// spam map
const spamMap = {};

// ensure guild config
function ensureGuildConfig(guildId) {
  if (!config.guilds[guildId]) {
    config.guilds[guildId] = {
      adminRole: null,
      harshness: 1,
      modules: {
        textFilter: false,
        imageFilter: false,
        gamblingFilter: false,
        drugsFilter: false,
        violenceFilter: false,
        hateFilter: false,
        selfharmFilter: false,
        scamFilter: false,
        spamFilter: false,
        linkFilter: false,
        inviteFilter: false
      },
      strikes: {},
      logsChannelId: null
    };
  }
  return config.guilds[guildId];
}

// logging
async function logEvent(guild, guildConfig, title, description, fields = []) {
  try {
    let channel = guildConfig.logsChannelId
      ? guild.channels.cache.get(guildConfig.logsChannelId)
      : null;

    if (!channel) {
      channel = guild.channels.cache.find(c => c.name === "filterprotect-logs" && c.isTextBased());
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

// permissions check
function canManage(interaction, guildConfig) {
  if (interaction.user.id === interaction.guild.ownerId) return true;
  if (!guildConfig.adminRole) return false;
  const member = interaction.member;
  return member.roles.cache.has(guildConfig.adminRole);
}

// GUILD JOIN → welcome + base config
client.on(Events.GuildCreate, async (guild) => {
  ensureGuildConfig(guild.id);
  saveConfig();

  const channel = guild.systemChannel || guild.channels.cache.find(c => c.isTextBased());
  if (!channel) return;

  const embed = new EmbedBuilder()
    .setTitle("👋 Welcome to FilterProtect")
    .setDescription(
      "Thanks for adding **FilterProtect**.\n\n" +
      "Before it can protect your server, you must complete setup.\n\n" +
      "Only the **server owner** or a chosen **admin role** can configure the bot."
    )
    .setColor("#5865F2");

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("fp_start_setup")
      .setLabel("Start Setup")
      .setStyle(ButtonStyle.Primary)
  );

  await channel.send({ embeds: [embed], components: [row] });
});

// interaction handler (buttons + menus)
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.inGuild()) return;
  const guildId = interaction.guild.id;
  const guildConfig = ensureGuildConfig(guildId);

  // BUTTONS
  if (interaction.isButton()) {
    const id = interaction.customId;

    // start setup
    if (id === "fp_start_setup") {
      if (interaction.user.id !== interaction.guild.ownerId) {
        return interaction.reply({
          content: "❌ Only the **server owner** can start setup.",
          ephemeral: true
        });
      }

      const embed = new EmbedBuilder()
        .setTitle("⚙️ FilterProtect Setup")
        .setDescription("Use the buttons below to configure FilterProtect.\n\nPage 1: Admin & Logs\nPage 2: Modules\nPage 3: Harshness\nPage 4: Finish")
        .setColor("#5865F2");

      const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("fp_page1").setLabel("Page 1").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("fp_page2").setLabel("Page 2").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("fp_page3").setLabel("Page 3").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("fp_page4").setLabel("Finish").setStyle(ButtonStyle.Success)
      );

      return interaction.reply({ embeds: [embed], components: [row1], ephemeral: true });
    }

    // page 1: admin + logs
    if (id === "fp_page1") {
      if (!canManage(interaction, guildConfig)) {
        return interaction.reply({ content: "❌ You cannot manage FilterProtect.", ephemeral: true });
      }

      const embed = new EmbedBuilder()
        .setTitle("⚙️ Setup — Page 1 (Admin & Logs)")
        .setDescription("Select an admin role and configure the logs channel.")
        .setColor("#5865F2")
        .addFields(
          { name: "Admin Role", value: guildConfig.adminRole ? `<@&${guildConfig.adminRole}>` : "Not set", inline: true },
          { name: "Logs Channel", value: guildConfig.logsChannelId ? `<#${guildConfig.logsChannelId}>` : "Auto / Not set", inline: true }
        );

      const roles = interaction.guild.roles.cache
        .filter(r => r.name !== "@everyone")
        .map(r => ({ label: r.name.slice(0, 100), value: r.id }));

      const roleMenu = new StringSelectMenuBuilder()
        .setCustomId("fp_admin_role_select")
        .setPlaceholder("Select admin role")
        .addOptions(roles.slice(0, 25));

      const logsButton = new ButtonBuilder()
        .setCustomId("fp_set_logs_here")
        .setLabel("Set this channel as logs")
        .setStyle(ButtonStyle.Primary);

      const row1 = new ActionRowBuilder().addComponents(roleMenu);
      const row2 = new ActionRowBuilder().addComponents(logsButton);

      return interaction.update({ embeds: [embed], components: [row1, row2] });
    }

    // page 2: modules
    if (id === "fp_page2") {
      if (!canManage(interaction, guildConfig)) {
        return interaction.reply({ content: "❌ You cannot manage FilterProtect.", ephemeral: true });
      }

      const m = guildConfig.modules;
      const embed = new EmbedBuilder()
        .setTitle("⚙️ Setup — Page 2 (Modules)")
        .setDescription("Toggle modules on or off.")
        .setColor("#5865F2")
        .addFields(
          { name: "Text Filter", value: m.textFilter ? "✅ ON" : "❌ OFF", inline: true },
          { name: "Image Filter", value: m.imageFilter ? "✅ ON" : "❌ OFF", inline: true },
          { name: "Spam Filter", value: m.spamFilter ? "✅ ON" : "❌ OFF", inline: true },
          { name: "Link Filter", value: m.linkFilter ? "✅ ON" : "❌ OFF", inline: true },
          { name: "Invite Filter", value: m.inviteFilter ? "✅ ON" : "❌ OFF", inline: true },
          { name: "Gambling Filter", value: m.gamblingFilter ? "✅ ON" : "❌ OFF", inline: true },
          { name: "Drugs Filter", value: m.drugsFilter ? "✅ ON" : "❌ OFF", inline: true },
          { name: "Violence Filter", value: m.violenceFilter ? "✅ ON" : "❌ OFF", inline: true },
          { name: "Hate Filter", value: m.hateFilter ? "✅ ON" : "❌ OFF", inline: true },
          { name: "Self‑harm Filter", value: m.selfharmFilter ? "✅ ON" : "❌ OFF", inline: true },
          { name: "Scam Filter", value: m.scamFilter ? "✅ ON" : "❌ OFF", inline: true }
        );

      const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("fp_toggle_text").setLabel("Text").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("fp_toggle_image").setLabel("Image").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("fp_toggle_spam").setLabel("Spam").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("fp_toggle_links").setLabel("Links").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("fp_toggle_invites").setLabel("Invites").setStyle(ButtonStyle.Primary)
      );

      const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("fp_toggle_gambling").setLabel("Gambling").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("fp_toggle_drugs").setLabel("Drugs").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("fp_toggle_violence").setLabel("Violence").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("fp_toggle_hate").setLabel("Hate").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("fp_toggle_selfharm").setLabel("Self‑harm").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("fp_toggle_scams").setLabel("Scams").setStyle(ButtonStyle.Secondary)
      );

      return interaction.update({ embeds: [embed], components: [row1, row2] });
    }

    // page 3: harshness
    if (id === "fp_page3") {
      if (!canManage(interaction, guildConfig)) {
        return interaction.reply({ content: "❌ You cannot manage FilterProtect.", ephemeral: true });
      }

      const embed = new EmbedBuilder()
        .setTitle("⚙️ Setup — Page 3 (Harshness)")
        .setDescription(
          "Choose how strict FilterProtect should be:\n\n" +
          "**1 Soft** — delete + warn\n" +
          "**2 Medium** — delete + warn + strike\n" +
          "**3 Hard** — delete + timeout\n" +
          "**4 Extreme** — delete + timeout + auto‑kick after 3 strikes"
        )
        .setColor("#5865F2")
        .addFields({ name: "Current", value: guildConfig.harshness.toString(), inline: true });

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("fp_h1").setLabel("1").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("fp_h2").setLabel("2").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("fp_h3").setLabel("3").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("fp_h4").setLabel("4").setStyle(ButtonStyle.Danger)
      );

      return interaction.update({ embeds: [embed], components: [row] });
    }

    // page 4: finish
    if (id === "fp_page4") {
      if (!canManage(interaction, guildConfig)) {
        return interaction.reply({ content: "❌ You cannot manage FilterProtect.", ephemeral: true });
      }

      saveConfig();

      const embed = new EmbedBuilder()
        .setTitle("✅ Setup Complete")
        .setDescription("FilterProtect is now active with your chosen settings.")
        .setColor("#57F287");

      return interaction.update({ embeds: [embed], components: [] });
    }

    // set logs here
    if (id === "fp_set_logs_here") {
      if (!canManage(interaction, guildConfig)) {
        return interaction.reply({ content: "❌ You cannot manage FilterProtect.", ephemeral: true });
      }
      guildConfig.logsChannelId = interaction.channel.id;
      saveConfig();
      return interaction.reply({ content: `✅ Logs channel set to <#${interaction.channel.id}>`, ephemeral: true });
    }

    // module toggles
    const toggleMap = {
      fp_toggle_text: "textFilter",
      fp_toggle_image: "imageFilter",
      fp_toggle_spam: "spamFilter",
      fp_toggle_links: "linkFilter",
      fp_toggle_invites: "inviteFilter",
      fp_toggle_gambling: "gamblingFilter",
      fp_toggle_drugs: "drugsFilter",
      fp_toggle_violence: "violenceFilter",
      fp_toggle_hate: "hateFilter",
      fp_toggle_selfharm: "selfharmFilter",
      fp_toggle_scams: "scamFilter"
    };

    if (toggleMap[id]) {
      if (!canManage(interaction, guildConfig)) {
        return interaction.reply({ content: "❌ You cannot manage FilterProtect.", ephemeral: true });
      }
      const key = toggleMap[id];
      guildConfig.modules[key] = !guildConfig.modules[key];
      saveConfig();
      return interaction.reply({
        content: `🔧 **${key}** is now **${guildConfig.modules[key] ? "ENABLED" : "DISABLED"}**`,
        ephemeral: true
      });
    }

    // harshness buttons
    if (id.startsWith("fp_h")) {
      if (!canManage(interaction, guildConfig)) {
        return interaction.reply({ content: "❌ You cannot manage FilterProtect.", ephemeral: true });
      }
      const level = Number(id.replace("fp_h", ""));
      guildConfig.harshness = level;
      saveConfig();
      return interaction.reply({ content: `⚠️ Harshness set to **${level}**`, ephemeral: true });
    }
  }

  // SELECT MENUS
  if (interaction.isStringSelectMenu()) {
    if (interaction.customId === "fp_admin_role_select") {
      if (!canManage(interaction, guildConfig)) {
        return interaction.reply({ content: "❌ You cannot manage FilterProtect.", ephemeral: true });
      }
      const roleId = interaction.values[0];
      guildConfig.adminRole = roleId;
      saveConfig();
      return interaction.reply({ content: `✅ Admin role set to <@&${roleId}>`, ephemeral: true });
    }
  }
});

// message filtering
client.on("messageCreate", async (message) => {
  if (!message.guild || message.author.bot) return;
  const guildId = message.guild.id;
  const guildConfig = ensureGuildConfig(guildId);
  const modules = guildConfig.modules;

  const content = (message.content || "").toLowerCase();

  // helper
  function contains(list) {
    return list.some(w => content.includes(w));
  }

  async function punish(reason) {
    try {
      await message.delete().catch(() => {});
      const harsh = guildConfig.harshness;

      // warn
      await message.channel.send({
        content: `⚠️ ${message.author}, ${reason}`
      }).then(m => setTimeout(() => m.delete().catch(() => {}), 5000));

      // strikes + timeout + kick
      if (harsh >= 2) {
        if (!guildConfig.strikes[message.author.id]) guildConfig.strikes[message.author.id] = 0;
        guildConfig.strikes[message.author.id]++;
        saveConfig();
      }

      if (harsh >= 3) {
        try {
          await message.member.timeout(10 * 60 * 1000, "FilterProtect auto-timeout");
        } catch {}
      }

      if (harsh === 4) {
        const strikes = guildConfig.strikes[message.author.id] || 0;
        if (strikes >= 3) {
          try {
            await message.member.kick("FilterProtect auto-kick (3 strikes)");
          } catch {}
        }
      }

      await logEvent(
        message.guild,
        guildConfig,
        "🚨 FilterProtect Action",
        reason,
        [
          { name: "User", value: `${message.author.tag} (${message.author.id})`, inline: true },
          { name: "Channel", value: `${message.channel}`, inline: true },
          { name: "Content", value: message.content || "[no text]", inline: false }
        ]
      );
    } catch (e) {
      console.error("Punish error:", e);
    }
  }

  // TEXT FILTER
  if (modules.textFilter) {
    if (contains(WORDS.nsfw)) return punish("NSFW text detected.");
    if (contains(WORDS.slurs) && modules.hateFilter !== false) return punish("Hate speech detected.");
    if (contains(WORDS.violence) && modules.violenceFilter) return punish("Violent content detected.");
    if (contains(WORDS.drugs) && modules.drugsFilter) return punish("Drug-related content detected.");
    if (contains(WORDS.gambling) && modules.gamblingFilter) return punish("Gambling content detected.");
    if (contains(WORDS.scams) && modules.scamFilter) return punish("Scam/phishing content detected.");
    if (contains(WORDS.selfharm) && modules.selfharmFilter) return punish("Self-harm encouragement detected.");
    if (contains(WORDS.grooming)) return punish("Grooming/predatory language detected.");
  }

  // LINK FILTER
  if (modules.linkFilter || modules.inviteFilter) {
    const linkRegex = /(https?:\/\/[^\s]+)/gi;
    if (linkRegex.test(content)) {
      if (modules.inviteFilter && (content.includes("discord.gg") || content.includes("discord.com/invite"))) {
        return punish("Discord invite link blocked.");
      }
      if (modules.linkFilter) {
        return punish("Link blocked.");
      }
    }
  }

  // SPAM FILTER (advanced)
  if (modules.spamFilter) {
    const now = Date.now();
    const key = `${guildId}-${message.author.id}`;
    if (!spamMap[key]) spamMap[key] = { last: 0, count: 0, lastMsg: "" };
    const data = spamMap[key];

    // speed
    if (now - data.last < 1500) data.count++;
    else data.count = 1;

    // duplicate
    if (message.content === data.lastMsg) data.count++;

    data.last = now;
    data.lastMsg = message.content;
    spamMap[key] = data;

    // caps
    const caps = content.replace(/[^A-Z]/g, "").length;
    const capsRatio = content.length > 0 ? caps / content.length : 0;

    // emoji spam
    const emojiCount = (message.content.match(/<a?:\w+:\d+>/g) || []).length;

    // mass mention
    const mentionCount = message.mentions.users.size + message.mentions.roles.size + (message.mentions.everyone ? 1 : 0);

    if (data.count >= 6 || capsRatio > 0.7 || emojiCount >= 8 || mentionCount >= 5) {
      return punish("Spam detected.");
    }
  }

  // IMAGE FILTER (AI, ultra‑strict style)
  if (modules.imageFilter && message.attachments.size > 0 && HF_API_KEY) {
    for (const att of message.attachments.values()) {
      const url = att.url;
      if (!url.match(/\.(jpg|jpeg|png|gif|webp)$/i)) continue;

      const label = await classifyImage(url);
      if (!label) continue;

      // ultra‑strict: anything not neutral/drawing is suspicious
      const badLabels = ["porn", "hentai", "sexy", "gore", "blood", "weapon", "drugs", "violence"];
      if (badLabels.includes(label) || label !== "neutral") {
        return punish(`Inappropriate image detected (${label}).`);
      }
    }
  }
});

client.once("ready", () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.login(process.env.DISCORD_TOKEN);
