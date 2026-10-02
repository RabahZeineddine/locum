import { settingsService, type SettingsService } from "./settings-service.js";

/** Chave única da preferência, para os dois processos lerem o mesmo lugar. */
export const LANGUAGE_KEY = "i18n.language";

/** Os idiomas que têm dicionário em `app/locales`. */
export const SUPPORTED_LANGUAGES = ["en", "pt-BR"] as const;

export type Language = (typeof SUPPORTED_LANGUAGES)[number];

/**
 * O idioma base. As chaves são escritas em inglês, então é aqui que cai tanto
 * a máquina configurada num idioma que o Locum não fala quanto a chave que
 * existe num dicionário e falta no outro.
 */
export const FALLBACK_LANGUAGE: Language = "en";

export interface LanguageState {
  /** O que a janela e a bandeja vão usar agora. */
  language: Language;
  /** `null` quando ninguém escolheu e vale o que a máquina disser. */
  preference: Language | null;
  /** O que o sistema operacional respondeu, tal como veio. */
  system: string;
  available: readonly Language[];
}

function isLanguage(value: string): value is Language {
  return (SUPPORTED_LANGUAGES as readonly string[]).includes(value);
}

/**
 * Acha o dicionário que atende uma etiqueta de idioma do sistema.
 *
 * O casamento é por etiqueta inteira primeiro e por subetiqueta primária
 * depois, que é o que faz `pt-PT` e `pt` chegarem ao `pt-BR`: quem configurou
 * a máquina em português prefere português imperfeito a inglês perfeito.
 * Etiqueta de idioma não diferencia maiúscula de minúscula, e o macOS devolve
 * `pt-br` em algumas versões.
 */
export function matchLanguage(locale: string): Language | undefined {
  const etiqueta = locale.trim().toLowerCase();
  if (etiqueta === "") return undefined;

  const exato = SUPPORTED_LANGUAGES.find((idioma) => idioma.toLowerCase() === etiqueta);
  if (exato !== undefined) return exato;

  const primaria = etiqueta.split("-")[0];
  return SUPPORTED_LANGUAGES.find((idioma) => idioma.toLowerCase().split("-")[0] === primaria);
}

/**
 * Em que idioma o Locum fala com quem está na frente da máquina.
 *
 * A regra mora aqui, e não na casca Electron, porque a linha de comando e a
 * bandeja precisam da mesma resposta que a janela. O que a casca traz é só a
 * etiqueta do sistema, que é a única parte que depende do Electron.
 */
export class I18nService {
  constructor(private readonly settings: SettingsService = settingsService) {}

  /**
   * A etiqueta do sistema para quem gera texto fora da janela (prompt de
   * sessao, passagem, modelo do contexto). Fora do Electron nao ha etiqueta
   * confiavel e vale o idioma de reserva; a casca troca pela do `app` no
   * `ready`.
   */
  private systemLocale: () => string = () => FALLBACK_LANGUAGE;

  useSystemLocale(fonte: () => string): void {
    this.systemLocale = fonte;
  }

  /** O idioma que vale agora: a preferencia, senao o do sistema, senao o de reserva. */
  async current(): Promise<Language> {
    return (await this.resolve(this.systemLocale())).language;
  }

  /** `null` quando ninguém escolheu e vale o idioma do sistema. */
  async getPreference(): Promise<Language | null> {
    const guardado = await this.settings.get(LANGUAGE_KEY);
    if (guardado === undefined) return null;
    // Idioma que saiu do catálogo depois de alguém já ter escolhido ele não
    // pode travar a janela: a preferência volta a ser a do sistema.
    return isLanguage(guardado) ? guardado : null;
  }

  /** `null` devolve a escolha ao sistema, que não é o mesmo que escolher `en`. */
  async setPreference(language: Language | null): Promise<void> {
    if (language === null) {
      await this.settings.remove(LANGUAGE_KEY);
      return;
    }
    if (!isLanguage(language)) {
      throw new Error(
        `idioma "${String(language)}" nao tem dicionario, os que tem sao ${SUPPORTED_LANGUAGES.join(", ")}`,
      );
    }
    await this.settings.set(LANGUAGE_KEY, language);
  }

  async resolve(systemLocale: string): Promise<LanguageState> {
    const preference = await this.getPreference();
    const language = preference ?? matchLanguage(systemLocale) ?? FALLBACK_LANGUAGE;
    return { language, preference, system: systemLocale, available: SUPPORTED_LANGUAGES };
  }
}

export const i18nService = new I18nService();
