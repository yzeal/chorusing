import React from 'react';

const Header: React.FC = () => (
  <header className="header">
    <h1 className="main-title">Pitch Accent Trainer</h1>
    <style>{`
      @media (max-width: 768px) {
        .main-title {
          font-size: 1.2rem !important;
          margin: 0.5rem 0 !important;
        }
      }
      .main-title {
        font-size: 2rem;
        margin: 0.5rem 0;
      }
    `}</style>
  </header>
);

export default Header; 