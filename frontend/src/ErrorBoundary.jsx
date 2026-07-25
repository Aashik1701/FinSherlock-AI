import React from 'react'

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error }
  }

  componentDidCatch(error, errorInfo) {
    console.error("FinSherlock UI Error Boundary caught an error:", error, errorInfo)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="bg-red-950/30 border border-red-900/50 rounded-2xl p-6 my-4 space-y-3">
          <div className="flex items-center gap-2 text-red-400 font-bold text-sm">
            <span>⚠</span>
            <span>UI Render Error Caught</span>
          </div>
          <p className="text-xs text-red-300 font-mono font-medium">
            {this.state.error?.toString()}
          </p>
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            className="px-3 py-1.5 bg-red-900/60 hover:bg-red-800 text-xs font-mono text-white rounded-lg transition-colors"
          >
            Reset UI View
          </button>
        </div>
      )
    }

    return this.props.children
  }
}
