export const languages = { en: 'English', es: 'Español' } as const;
export const defaultLang = 'en';

export const ui = {
  en: {
    'nav.process': 'Process',
    'nav.role': 'Role',
    'nav.flow': 'Flow',
    'nav.apply': 'Apply',
    'nav.assessment': 'Assessment',
    'nav.takehome': 'Take-home',
    'nav.privacy': 'Privacy',
    'site.title': 'TailorMind — Talent',
    'site.tagline': 'Hiring senior AI-empowered developers, remote from Peru.',
    'comp.reveal': 'Reveal compensation range',
    'comp.value': 'Monthly: 4–6 Peruvian minimum wages (PEN). Final offer based on level and seniority.',
    'comp.gateLabel': 'Enter your email to reveal',
    'comp.gateSubmit': 'Reveal',
  },
  es: {
    'nav.process': 'Proceso',
    'nav.role': 'Rol',
    'nav.flow': 'Flujo',
    'nav.apply': 'Postular',
    'nav.assessment': 'Evaluación',
    'nav.takehome': 'Take-home',
    'nav.privacy': 'Privacidad',
    'site.title': 'TailorMind — Talento',
    'site.tagline': 'Contratamos desarrolladores senior potenciados por IA, remoto desde Perú.',
    'comp.reveal': 'Revelar rango de compensación',
    'comp.value': 'Mensual: 4–6 sueldos mínimos peruanos (PEN). Oferta final según nivel y seniority.',
    'comp.gateLabel': 'Ingresa tu email para revelar',
    'comp.gateSubmit': 'Revelar',
  },
} as const;

export type Lang = keyof typeof ui;
export function t(lang: Lang, key: keyof typeof ui['en']): string {
  return ui[lang][key] ?? ui[defaultLang][key];
}
