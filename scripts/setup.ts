import { botConfig } from '../config/bot-config';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

// Load environment variables
dotenv.config();

function validateConfig() {
  const errors: string[] = [];
  
  // Check if startUrl is configured
  if (botConfig.startUrl === 'https://example.com') {
    errors.push('❌ startUrl er ikke konfigurert (bruker fortsatt default verdi)');
  }
  
  // Check if botName is configured
  if (botConfig.botName === 'Chatbot') {
    errors.push('❌ botName er ikke konfigurert (bruker fortsatt default verdi)');
  }
  
  // Check if homepageUrls are configured
  if (botConfig.homepageUrls.length === 0 || 
      botConfig.homepageUrls[0] === 'https://example.com') {
    errors.push('❌ homepageUrls er ikke konfigurert (bruker fortsatt default verdi)');
  }
  
  // Check if system prompt is customized (basic check - if it's very short, it might be default)
  if (botConfig.botSystemPrompt.includes('En hjelpsom assistent') && 
      botConfig.botSystemPrompt.length < 500) {
    // This is a basic check - if it's very short, it might be default
    console.warn('⚠️  System prompt ser ut til å være kort - vurder å tilpasse den');
  }
  
  // Check environment variables
  const requiredEnvVars = [
    'OPENAI_API_KEY',
    'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
    'FIRECRAWL_API_KEY',
  ];
  
  const missingEnvVars: string[] = [];
  for (const envVar of requiredEnvVars) {
    if (!process.env[envVar] || process.env[envVar] === `your_${envVar.toLowerCase()}_here`) {
      missingEnvVars.push(envVar);
    }
  }
  
  if (missingEnvVars.length > 0) {
    errors.push(`❌ Manglende miljøvariabler: ${missingEnvVars.join(', ')}`);
    errors.push('   Sjekk at .env filen er opprettet og fylt ut');
  }
  
  if (errors.length > 0) {
    console.error('\n⚠️  Konfigurasjonsfeil funnet:\n');
    errors.forEach(err => console.error(err));
    console.error('\n💡 Vennligst oppdater config/bot-config.ts og .env filen\n');
    process.exit(1);
  }
  
  console.log('✅ Konfigurasjon er gyldig!');
  console.log(`   Bot navn: ${botConfig.botName}`);
  console.log(`   Start URL: ${botConfig.startUrl}`);
  console.log(`   Logo: ${botConfig.logoPath}`);
  console.log(`   Homepage URLs: ${botConfig.homepageUrls.length} konfigurert`);
  console.log(`   Miljøvariabler: Alle satt`);
}

validateConfig();

