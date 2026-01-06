import Chatbot from './components/Chatbot';

export default function Home() {
  return (
    <div 
      style={{ 
        minHeight: '100vh',
        backgroundImage: 'url(/assets/mvp.png)',
        backgroundSize: 'cover',
        backgroundPosition: 'center',
        backgroundRepeat: 'no-repeat',
        backgroundAttachment: 'fixed'
      }}
    >
      <Chatbot />
    </div>
  );
}
